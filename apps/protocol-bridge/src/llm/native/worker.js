#!/usr/bin/env node
/**
 * Cloud Code Native Worker Process
 *
 * Runs using the Antigravity IDE's own Node.js binary and modules.
 * Replicates the IDE's Cloud Code client logic for 100% fingerprint fidelity.
 *
 * Communication: JSON Lines over stdin/stdout
 *
 * Request format:
 *   { "id": "req-1", "method": "generate", "params": { ... } }
 *
 * Response format:
 *   { "id": "req-1", "result": { ... } }             // success
 *   { "id": "req-1", "error": { "message": "..." } } // error
 *   { "id": "req-1", "stream": { ... } }              // streaming chunk
 *   { "id": "req-1", "stream": null }                 // stream end
 */

"use strict"

const { OAuth2Client } = require("google-auth-library")
const os = require("os")
const readline = require("readline")

// ---------------------------------------------------------------------------
// OAuth Credentials (Cloud Code API)
// ---------------------------------------------------------------------------
const OAUTH_NON_GCP = {
  clientId:
    "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
  clientSecret: "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",
}

const OAUTH_GCP_TOS = {
  clientId:
    "884354919052-36trc1jjb3tguiac32ov6cod268c5blh.apps.googleusercontent.com",
  clientSecret: "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",
}

// ---------------------------------------------------------------------------
// Cloud Code Endpoints
// ---------------------------------------------------------------------------
const ENDPOINTS = {
  sandbox: "https://autopush-cloudcode-pa.sandbox.googleapis.com",
  daily: "https://daily-cloudcode-pa.googleapis.com",
  production: "https://cloudcode-pa.googleapis.com",
}

// ---------------------------------------------------------------------------
// Serialization helpers — replicates Tk() from main.js
// Cloud Code API uses camelCase on the wire for both request and response.
// snakeToCamel is retained as a safety net for older API versions.
// Note: BGe() (camelToSnake) exists in main.js source but traffic capture
// confirms the official IDE sends camelCase on the wire.
// ---------------------------------------------------------------------------
function camelToSnake(obj) {
  if (obj == null || typeof obj !== "object") return obj
  if (Array.isArray(obj)) return obj.map(camelToSnake)
  const result = {}
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const snakeKey = key.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`)
      result[snakeKey] = camelToSnake(obj[key])
    }
  }
  return result
}

function snakeToCamel(obj) {
  if (obj == null || typeof obj !== "object") return obj
  if (Array.isArray(obj)) return obj.map(snakeToCamel)
  const result = {}
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const camelKey = key.replace(/_([a-z])/g, (_, ch) => ch.toUpperCase())
      result[camelKey] = snakeToCamel(obj[key])
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Worker State
// ---------------------------------------------------------------------------
let oauthClient = null
let config = null
let endpoint = null
let cloudaicompanionProject = null

function extractCloudCodeProjectId(result) {
  if (!result || typeof result !== "object") return null
  if (
    typeof result.cloudaicompanionProject === "string" &&
    result.cloudaicompanionProject.trim() !== ""
  ) {
    return result.cloudaicompanionProject.trim()
  }
  return null
}

function attachCloudCodeMeta(result, response) {
  const traceId = response.headers.get("x-cloudaicompanion-trace-id")
  if (!traceId || !result || typeof result !== "object") {
    return result
  }
  return {
    ...result,
    __cloudCodeMeta: {
      traceId,
    },
  }
}

/**
 * User-Agent string matching Antigravity IDE format.
 */
function getUserAgent() {
  const version = config?.ideVersion || "1.20.6"
  const ideName = config?.isGcpTos ? "jetski" : "antigravity"
  return `${ideName}/${version} ${os.platform()}/${os.arch()}`
}

/**
 * Build IDE metadata for Cloud Code requests.
 */
function buildIdeMetadata() {
  return {
    ideName: config?.isGcpTos ? "jetski" : "antigravity",
    ideVersion: config?.ideVersion || "1.20.6",
  }
}

/**
 * Convert a Gemini generateContent payload to TabChat format.
 * TabChat is the only AI generation endpoint in the new Cloud Code API.
 */
function convertToTabChatPayload(payload) {
  const request = payload.request || {}
  const contents = request.contents || []
  const genConfig = request.generationConfig || {}

  // Convert contents to chatMessagePrompts
  const chatMessagePrompts = []
  let systemPrompt = ""

  // Extract system instruction
  if (request.systemInstruction) {
    const siParts = request.systemInstruction.parts || []
    systemPrompt = siParts.map((p) => p.text || "").join("\n")
  }

  for (const msg of contents) {
    if (!msg) continue
    if (msg.role === "system") {
      systemPrompt = (msg.parts || []).map((p) => p.text || "").join("\n")
      continue
    }
    const source =
      msg.role === "model"
        ? "CHAT_MESSAGE_SOURCE_ASSISTANT"
        : "CHAT_MESSAGE_SOURCE_USER"
    for (const part of msg.parts || []) {
      if (part.text !== undefined) {
        const prompt = { source, prompt: part.text }
        if (part.thought) {
          prompt.thinking = part.text
          prompt.prompt = ""
        }
        if (part.thoughtSignature) {
          prompt.signature = part.thoughtSignature
        }
        chatMessagePrompts.push(prompt)
      } else if (part.functionCall) {
        chatMessagePrompts.push({
          source: "CHAT_MESSAGE_SOURCE_ASSISTANT",
          prompt: "",
          toolCalls: [
            {
              name: part.functionCall.name,
              arguments: JSON.stringify(part.functionCall.args || {}),
              id: part.functionCall.id || "",
            },
          ],
        })
      } else if (part.functionResponse) {
        chatMessagePrompts.push({
          source: "CHAT_MESSAGE_SOURCE_USER",
          prompt:
            typeof part.functionResponse.response === "string"
              ? part.functionResponse.response
              : JSON.stringify(part.functionResponse.response || {}),
          toolCallId:
            part.functionResponse.id || part.functionResponse.name || "",
        })
      }
    }
  }

  // Convert tools
  const chatTools = []
  if (request.tools) {
    for (const toolGroup of request.tools) {
      for (const decl of toolGroup.functionDeclarations || []) {
        chatTools.push({
          name: decl.name,
          description: decl.description || "",
          jsonSchemaString: JSON.stringify(decl.parameters || {}),
        })
      }
    }
  }

  // Build configuration
  const configuration = {}
  if (genConfig.temperature !== undefined)
    configuration.temperature = genConfig.temperature
  if (genConfig.maxOutputTokens !== undefined)
    configuration.maxTokens = genConfig.maxOutputTokens

  const getChatMessageRequest = {
    metadata: buildIdeMetadata(),
    prompt: systemPrompt,
    chatMessagePrompts,
    requestType: "CHAT_MESSAGE_REQUEST_TYPE_CASCADE",
    chatModelName: payload.model || "",
  }
  if (chatTools.length > 0) getChatMessageRequest.tools = chatTools
  if (Object.keys(configuration).length > 0)
    getChatMessageRequest.configuration = configuration

  return {
    project:
      cloudaicompanionProject || payload.project || config.projectId || "",
    request: getChatMessageRequest,
  }
}

/**
 * Convert a TabChat SSE response chunk to Gemini format.
 */
function convertTabChatResponseToGemini(chunk) {
  const resp = chunk.response || chunk
  const parts = []
  if (resp.deltaThinking)
    parts.push({ text: resp.deltaThinking, thought: true })
  if (resp.deltaText) parts.push({ text: resp.deltaText })
  const toolCalls = resp.deltaToolCalls || []
  for (const tc of toolCalls) {
    parts.push({
      functionCall: {
        name: tc.name || "",
        args: tc.arguments ? JSON.parse(tc.arguments) : {},
        id: tc.id || "",
      },
    })
  }
  if (parts.length === 0) parts.push({ text: "" })
  let finishReason = undefined
  if (
    resp.stopReason &&
    resp.stopReason !== "STOP_REASON_UNSPECIFIED" &&
    resp.stopReason !== 0
  )
    finishReason = "STOP"
  return { candidates: [{ content: { role: "model", parts }, finishReason }] }
}

/**
 * Select Cloud Code endpoint based on account type
 * Replicates yqn() from main.js
 */
function selectEndpoint(account) {
  if (account.cloudCodeUrlOverride) return account.cloudCodeUrlOverride
  if (account.isGcpTos) return ENDPOINTS.production
  return ENDPOINTS.daily
}

/**
 * Initialize OAuth2Client for the given account
 */
function initializeClient(account) {
  const creds = account.isGcpTos ? OAUTH_GCP_TOS : OAUTH_NON_GCP
  oauthClient = new OAuth2Client(creds.clientId, creds.clientSecret)
  oauthClient.setCredentials({
    access_token: account.accessToken,
    refresh_token: account.refreshToken,
    expiry_date: account.expiresAt
      ? new Date(account.expiresAt).getTime()
      : Date.now() - 1000,
    token_type: "Bearer",
  })

  // Listen for token refresh events to report back
  oauthClient.on("tokens", (tokens) => {
    sendMessage({
      type: "token_refresh",
      tokens: {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || account.refreshToken,
        expiresAt: tokens.expiry_date
          ? new Date(tokens.expiry_date).toISOString()
          : undefined,
      },
    })
  })

  config = account
  endpoint = selectEndpoint(account)
}

// ---------------------------------------------------------------------------
// Retry config for 503 MODEL_CAPACITY_EXHAUSTED / 429 rate limit
// ---------------------------------------------------------------------------
const RETRY_STATUS_CODES = [503, 429]
const MAX_RETRIES = 3
const BASE_DELAY_MS = 2000 // 2s, 4s, 8s exponential backoff

// Quota-exhausted 429s are deterministic — the account is dead until reset.
// Don't waste retries on them; surface immediately so the pool can switch workers.
function isQuotaExhausted(responseText) {
  return (
    responseText.includes("QUOTA_EXHAUSTED") ||
    responseText.includes("exhausted your capacity")
  )
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Make authenticated request to Cloud Code API (with retry)
 * Replicates the w() method from Antigravity IDE
 */
async function cloudCodeRequest(apiMethod, payload) {
  let lastError = null

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1)
      process.stderr.write(
        `[retry] ${apiMethod} attempt ${attempt + 1}/${MAX_RETRIES + 1} after ${delay}ms\n`
      )
      await sleep(delay)
    }

    // Ensure fresh token
    const tokenResponse = await oauthClient.getAccessToken()
    const token = tokenResponse.token

    const url = `${endpoint}/v1internal:${apiMethod}`
    const body = JSON.stringify(payload)

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": getUserAgent(),
        // Accept-Encoding gzip removed for system Node.js compatibility
      },
      body,
    })

    if (response.ok) {
      const data = await response.json()
      return attachCloudCodeMeta(snakeToCamel(data), response)
    }

    const errorText = await response.text()
    lastError = new Error(
      `Cloud Code ${apiMethod} failed: ${response.status} ${errorText.slice(0, 500)}`
    )

    // Quota-exhausted 429 — don't retry, surface immediately to pool
    if (response.status === 429 && isQuotaExhausted(errorText)) {
      throw lastError
    }

    if (!RETRY_STATUS_CODES.includes(response.status)) {
      throw lastError // Non-retryable error
    }
  }

  throw lastError // All retries exhausted
}

/**
 * Make streaming request to Cloud Code API (SSE) with retry
 * Replicates streaming generateContent from Antigravity IDE
 */
async function* cloudCodeStreamRequest(apiMethod, payload) {
  let lastError = null

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1)
      process.stderr.write(
        `[retry] ${apiMethod} stream attempt ${attempt + 1}/${MAX_RETRIES + 1} after ${delay}ms\n`
      )
      await sleep(delay)
    }

    const tokenResponse = await oauthClient.getAccessToken()
    const token = tokenResponse.token

    const url = `${endpoint}/v1internal:${apiMethod}?alt=sse`
    const body = JSON.stringify(payload)

    // Debug: dump full payload for comparison with IDE traffic
    process.stderr.write(
      `[DEBUG] ${apiMethod} payload (${body.length} bytes): ${body.slice(0, 2000)}\n`
    )

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": getUserAgent(),
        // Accept-Encoding gzip removed for system Node.js compatibility
      },
      body,
    })

    if (response.ok) {
      const traceId = response.headers.get("x-cloudaicompanion-trace-id")
      if (traceId) {
        yield {
          __cloudCodeMeta: {
            traceId,
          },
        }
      }

      // Success — yield the stream and return
      // (falls through to the streaming loop below)
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() || ""

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || trimmed.startsWith(":")) continue
          if (trimmed.startsWith("data: ")) {
            const jsonStr = trimmed.slice(6)
            if (jsonStr === "[DONE]") return
            try {
              yield snakeToCamel(JSON.parse(jsonStr))
            } catch {
              // Skip malformed JSON
            }
          }
        }
      }

      // Process remaining buffer
      if (buffer.trim()) {
        const trimmed = buffer.trim()
        if (trimmed.startsWith("data: ") && trimmed.slice(6) !== "[DONE]") {
          try {
            yield snakeToCamel(JSON.parse(trimmed.slice(6)))
          } catch {
            // Skip
          }
        }
      }
      return // Stream completed successfully
    }

    const errorText = await response.text()
    lastError = new Error(
      `Cloud Code ${apiMethod} stream failed: ${response.status} ${errorText.slice(0, 500)}`
    )

    // Quota-exhausted 429 — don't retry, surface immediately to pool
    if (response.status === 429 && isQuotaExhausted(errorText)) {
      throw lastError
    }

    if (!RETRY_STATUS_CODES.includes(response.status)) {
      throw lastError // Non-retryable error
    }
  }

  throw lastError // All retries exhausted
}

// ---------------------------------------------------------------------------
// Request Handlers
// ---------------------------------------------------------------------------
async function handleInit(params) {
  initializeClient(params.account)

  // Force refresh access token on init.
  // When running on a server with ANTIGRAVITY_NODE_BINARY=/usr/bin/node,
  // the access_token from accounts.json is often stale (refreshed via other
  // channels like CPA). getAccessToken() may not auto-refresh if expiry_date
  // looks valid, so we explicitly call refreshAccessToken() here.
  try {
    const { credentials } = await oauthClient.refreshAccessToken()
    oauthClient.setCredentials(credentials)
    process.stderr.write(
      `[init] Token refreshed, expires: ${new Date(credentials.expiry_date)}\n`
    )
  } catch (refreshErr) {
    process.stderr.write(
      `[init] Token refresh failed: ${refreshErr.message}\n`
    )
  }

  return { status: "ok", endpoint }
}

async function handleCheckAvailability() {
  if (!oauthClient) throw new Error("Worker not initialized")
  // Use loadCodeAssist for lightweight availability check (same as IDE init)
  const payload = {
    metadata: buildIdeMetadata(),
    cloudaicompanionProject: config.projectId || "",
  }
  const result = await cloudCodeRequest("loadCodeAssist", payload)
  process.stderr.write(
    `[DEBUG] loadCodeAssist tier: ${result?.currentTier?.id}, project: ${result?.cloudaicompanionProject}\n`
  )
  // Cache cloudaicompanionProject for tabChat calls
  if (result && result.cloudaicompanionProject) {
    cloudaicompanionProject = result.cloudaicompanionProject
  }
  return { available: true }
}

async function handleGenerate(id, params) {
  if (!oauthClient) throw new Error("Worker not initialized")
  // Use streamGenerateContent (confirmed by traffic capture) and collect all chunks
  const payload = buildStreamPayload(params.payload)
  process.stderr.write(
    `[DEBUG] streamGenerateContent request: project=${payload.project}, model=${payload.model}\n`
  )
  const allParts = []
  let lastFinishReason = undefined
  let usageMetadata = undefined
  for await (const chunk of cloudCodeStreamRequest(
    "streamGenerateContent",
    payload
  )) {
    // SSE chunks have outer wrapper: { response: { candidates: [...] }, traceId, metadata }
    const inner = chunk.response || chunk
    if (inner.candidates?.[0]?.content?.parts) {
      for (const p of inner.candidates[0].content.parts) {
        allParts.push(p)
      }
    }
    if (inner.candidates?.[0]?.finishReason)
      lastFinishReason = inner.candidates[0].finishReason
    if (inner.usageMetadata) usageMetadata = inner.usageMetadata
  }
  const result = {
    candidates: [
      {
        content: {
          role: "model",
          parts: allParts.length > 0 ? allParts : [{ text: "" }],
        },
        finishReason: lastFinishReason || "STOP",
      },
    ],
  }
  if (usageMetadata) result.usageMetadata = usageMetadata
  return result
}

async function handleGenerateStream(id, params) {
  if (!oauthClient) throw new Error("Worker not initialized")
  // Use streamGenerateContent (confirmed by traffic capture) — forward SSE chunks directly
  const payload = buildStreamPayload(params.payload)
  process.stderr.write(
    `[DEBUG] streamGenerateContent stream: project=${payload.project}, model=${payload.model}\n`
  )
  for await (const chunk of cloudCodeStreamRequest(
    "streamGenerateContent",
    payload
  )) {
    // Unwrap outer response wrapper before forwarding
    const inner = chunk.response || chunk
    sendMessage({ id, stream: inner })
  }
  sendMessage({ id, stream: null }) // signal stream end
}

/**
 * Build streamGenerateContent payload matching IDE's actual format.
 * GoogleService already builds the full Cloud Code payload:
 *   { project, model, request: {...}, requestType, userAgent, requestId }
 * We only need to ensure requestId and project are set, then pass through.
 */
function buildStreamPayload(incomingPayload) {
  // If incoming payload already has a 'request' object with 'contents',
  // it's a fully-formed Cloud Code payload from GoogleService — pass through
  if (
    incomingPayload.request &&
    (incomingPayload.request.contents ||
      incomingPayload.request.systemInstruction)
  ) {
    const payload = { ...incomingPayload }
    // Ensure project is set (prefer cloudaicompanionProject from loadCodeAssist)
    if (cloudaicompanionProject) payload.project = cloudaicompanionProject
    // Ensure requestId is set
    if (!payload.requestId) {
      payload.requestId = `agent/${Date.now()}/${crypto.randomUUID()}`
    }
    return payload
  }

  // Otherwise, build from raw Gemini payload (legacy path)
  const payload = {
    project:
      cloudaicompanionProject ||
      incomingPayload.project ||
      config.projectId ||
      "",
    requestId: `agent/${Date.now()}/${crypto.randomUUID()}`,
    request: {},
  }
  if (incomingPayload.model) payload.model = incomingPayload.model

  const inner = {}
  if (incomingPayload.contents) inner.contents = incomingPayload.contents
  if (incomingPayload.systemInstruction)
    inner.systemInstruction = incomingPayload.systemInstruction
  if (incomingPayload.tools) inner.tools = incomingPayload.tools
  if (incomingPayload.generationConfig)
    inner.generationConfig = incomingPayload.generationConfig
  if (incomingPayload.toolConfig) inner.toolConfig = incomingPayload.toolConfig

  payload.request = inner
  return payload
}

async function handleLoadCodeAssist(params) {
  if (!oauthClient) throw new Error("Worker not initialized")
  const payload = {
    metadata: params.metadata || {},
  }
  const requestedProjectId =
    typeof params.projectId === "string" ? params.projectId.trim() : ""
  const currentProjectId =
    config && typeof config.projectId === "string" ? config.projectId.trim() : ""
  const projectId = requestedProjectId || currentProjectId
  if (projectId) {
    payload.cloudaicompanionProject = projectId
  }

  const result = await cloudCodeRequest("loadCodeAssist", payload)
  const resolvedProjectId = extractCloudCodeProjectId(result)
  if (resolvedProjectId && config) {
    config.projectId = resolvedProjectId
  }
  return result
}

async function handleWebSearch(params) {
  if (!oauthClient) throw new Error("Worker not initialized")
  const payload = {
    project: config.projectId || "",
    model: "gemini-2.5-flash",
    requestType: "web_search",
    request: {
      contents: [{ role: "user", parts: [{ text: params.query }] }],
      systemInstruction: {
        role: "user",
        parts: [
          {
            text: "You are a search engine bot. You will be given a query from a user. Your task is to search the web for relevant information that will help the user. You MUST perform a web search. Do not respond or interact with the user, please respond as if they typed the query into a search bar.",
          },
        ],
      },
      tools: [
        {
          googleSearch: {
            enhancedContent: {
              imageSearch: {
                maxResultCount: 5,
              },
            },
          },
        },
      ],
      generationConfig: {
        candidateCount: 1,
      },
    },
  }
  return await cloudCodeRequest("generateContent", payload)
}

async function handleFetchAvailableModels() {
  if (!oauthClient) throw new Error("Worker not initialized")
  const payload = {
    project: config.projectId || "",
  }
  return await cloudCodeRequest("fetchAvailableModels", payload)
}

async function handleFetchUserInfo(params) {
  if (!oauthClient) throw new Error("Worker not initialized")
  const requestedProjectId =
    params && typeof params.projectId === "string" ? params.projectId.trim() : ""
  const currentProjectId =
    config && typeof config.projectId === "string" ? config.projectId.trim() : ""
  const projectId = requestedProjectId || currentProjectId
  const payload = {}
  if (projectId) {
    payload.project = projectId
  }
  return await cloudCodeRequest("fetchUserInfo", payload)
}

async function handleRecordCodeAssistMetrics(params) {
  if (!oauthClient) throw new Error("Worker not initialized")
  if (!params || typeof params.payload !== "object" || !params.payload) {
    throw new Error("recordCodeAssistMetrics requires payload")
  }
  return await cloudCodeRequest("recordCodeAssistMetrics", params.payload)
}

async function handleRecordTrajectoryAnalytics(params) {
  if (!oauthClient) throw new Error("Worker not initialized")
  if (!params || typeof params.payload !== "object" || !params.payload) {
    throw new Error("recordTrajectoryAnalytics requires payload")
  }
  return await cloudCodeRequest("recordTrajectoryAnalytics", params.payload)
}

// ---------------------------------------------------------------------------
// IPC (JSON Lines over stdin/stdout)
// ---------------------------------------------------------------------------
function sendMessage(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n")
}

async function handleRequest(request) {
  const { id, method, params } = request
  try {
    let result
    switch (method) {
      case "init":
        result = await handleInit(params)
        break
      case "checkAvailability":
        result = await handleCheckAvailability()
        break
      case "generate":
        result = await handleGenerate(id, params)
        break
      case "generateStream":
        await handleGenerateStream(id, params)
        return // streaming responses sent inline
      case "loadCodeAssist":
        result = await handleLoadCodeAssist(params)
        break
      case "fetchAvailableModels":
        result = await handleFetchAvailableModels()
        break
      case "fetchUserInfo":
        result = await handleFetchUserInfo(params)
        break
      case "recordCodeAssistMetrics":
        result = await handleRecordCodeAssistMetrics(params)
        break
      case "recordTrajectoryAnalytics":
        result = await handleRecordTrajectoryAnalytics(params)
        break
      case "webSearch":
        result = await handleWebSearch(params)
        break
      default:
        throw new Error(`Unknown method: ${method}`)
    }
    sendMessage({ id, result })
  } catch (error) {
    sendMessage({
      id,
      error: { message: error.message, stack: error.stack },
    })
  }
}

// ---------------------------------------------------------------------------
// Main: read JSON Lines from stdin
// ---------------------------------------------------------------------------
const rl = readline.createInterface({
  input: process.stdin,
  terminal: false,
})

rl.on("line", (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  try {
    const request = JSON.parse(trimmed)
    handleRequest(request).catch((err) => {
      sendMessage({
        id: request.id,
        error: { message: err.message, stack: err.stack },
      })
    })
  } catch (err) {
    sendMessage({
      error: { message: `Invalid JSON: ${err.message}` },
    })
  }
})

rl.on("close", () => {
  process.exit(0)
})

// Signal ready
sendMessage({ type: "ready", pid: process.pid, userAgent: getUserAgent() })
