import fastifyCors from "@fastify/cors"
import { BadRequestException, Logger, ValidationPipe } from "@nestjs/common"
import { NestFactory } from "@nestjs/core"
import {
  FastifyAdapter,
  NestFastifyApplication,
} from "@nestjs/platform-fastify"
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger"
import * as fs from "fs"
import * as path from "path"
import { AppModule } from "./app.module"
import { registerContentTypeParsers } from "./shared/content-type-parsers"
import { registerRequestHooks } from "./shared/request-hooks"

async function bootstrap() {
  // ── Auto File Logging ──────────────────────────────────────────────
  // Mirror all stdout/stderr to .log/agent.log so that `npm run issues`
  // always has logs to collect, without requiring manual `| tee`.
  const logDir = path.join(__dirname, "..", "..", "..", ".log")
  fs.mkdirSync(logDir, { recursive: true })
  const logFilePath = path.join(logDir, "protocol-bridge.log")

  // Rotate: truncate if larger than 10 MB
  const MAX_LOG_SIZE = 10 * 1024 * 1024
  try {
    const stat = fs.statSync(logFilePath)
    if (stat.size > MAX_LOG_SIZE) {
      fs.writeFileSync(logFilePath, "")
    }
  } catch {
    // File doesn't exist yet, that's fine
  }

  const logStream = fs.createWriteStream(logFilePath, { flags: "a" })
  const timestamp = () => new Date().toISOString()

  // Write startup marker
  logStream.write(
    `\n${"=".repeat(60)}\n[${timestamp()}] Agent Vibes server starting\n${"=".repeat(60)}\n`
  )

  const origStdoutWrite = process.stdout.write.bind(process.stdout)
  const origStderrWrite = process.stderr.write.bind(process.stderr)

  // Only log warnings, errors, and stack traces to the file
  const ISSUE_LOG_PATTERN = /\b(WARN|ERROR|Error|Exception|FATAL|reject|fail)/i
  const STACK_TRACE_PATTERN = /^\s+at\s/
  let lastLineWasError = false

  const shouldLog = (text: string): boolean => {
    if (ISSUE_LOG_PATTERN.test(text)) {
      lastLineWasError = true
      return true
    }
    // Capture stack trace lines that follow errors
    if (lastLineWasError && STACK_TRACE_PATTERN.test(text)) {
      return true
    }
    lastLineWasError = false
    return false
  }

  process.stdout.write = ((
    chunk: string | Uint8Array,
    ...args: unknown[]
  ): boolean => {
    const text =
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString()
    if (shouldLog(text)) logStream.write(chunk)
    return origStdoutWrite(chunk, ...(args as []))
  }) as typeof process.stdout.write

  process.stderr.write = ((
    chunk: string | Uint8Array,
    ...args: unknown[]
  ): boolean => {
    // stderr is always relevant for diagnostics
    logStream.write(chunk)
    return origStderrWrite(chunk, ...(args as []))
  }) as typeof process.stderr.write
  // ── End Auto File Logging ──────────────────────────────────────────

  const logger = new Logger("Bootstrap")

  // Check if SSL certificates exist for HTTP/2
  const certPath = path.join(__dirname, "..", "certs", "localhost.crt")
  const keyPath = path.join(__dirname, "..", "certs", "localhost.key")
  const useHttp2 =
    fs.existsSync(certPath) &&
    fs.existsSync(keyPath) &&
    process.env.USE_HTTP2 !== "false"

  // Create Fastify adapter with HTTP/2 support
  const fastifyAdapter = new FastifyAdapter(
    useHttp2
      ? {
          logger: false,
          bodyLimit: 52428800, // 50MB
          http2: true,
          https: {
            allowHTTP1: true, // Allow HTTP/1.1 fallback (required for pf rdr on lo0)
            key: fs.readFileSync(keyPath),
            cert: fs.readFileSync(certPath),
          },
          // CRITICAL: Disable response buffering for SSE streaming
          // This ensures chunks are sent immediately to prevent Cursor timeout
          disableRequestLogging: true,
          requestIdHeader: false,
        }
      : {
          logger: false,
          bodyLimit: 52428800, // 50MB
          // CRITICAL: Disable response buffering for SSE streaming
          disableRequestLogging: true,
          requestIdHeader: false,
        }
  )

  // Get Fastify instance BEFORE creating NestJS app
  const fastifyInstance = fastifyAdapter.getInstance()

  // Register custom content type parsers for gRPC/ConnectRPC BEFORE NestJS initialization
  // This must be done before NestFactory.create() to avoid conflicts with NestJS default parsers
  registerContentTypeParsers(fastifyInstance, logger)

  // Create NestJS application
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    fastifyAdapter
  )
  app.enableShutdownHooks()

  // Enable CORS
  await fastifyInstance.register(fastifyCors, {
    origin: "*",
    methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: "*",
    credentials: false,
  })

  // Register request logging hooks
  registerRequestHooks(fastifyInstance, logger)

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      skipMissingProperties: true,
      exceptionFactory: (errors) => {
        logger.error(`[ValidationPipe] Validation failed:`)
        errors.forEach((error, index) => {
          logger.error(
            `[ValidationPipe] Error ${index + 1}: property=${error.property}, ` +
              `constraints=${JSON.stringify(error.constraints)}, ` +
              `value type=${typeof error.value}`
          )
        })
        // Return default BadRequestException
        return new BadRequestException(errors)
      },
    })
  )

  // Swagger documentation
  const config = new DocumentBuilder()
    .setTitle("Agent Vibes Proxy")
    .setDescription(
      "Unified Claude Code API Proxy with Antigravity and Gemini WebSearch"
    )
    .setVersion("1.0")
    .addApiKey({ type: "apiKey", name: "x-api-key", in: "header" }, "api-key")
    .build()

  const document = SwaggerModule.createDocument(app, config)
  SwaggerModule.setup("docs", app, document)

  const port = process.env.PORT || 8000
  await app.listen(port, "0.0.0.0")

  const protocol = useHttp2 ? "https" : "http"
  const http2Status = useHttp2
    ? "ENABLED (HTTP/2 only)"
    : "DISABLED (HTTP/1.1 only)"

  // ── Startup Banner ─────────────────────────────────────────────────
  // Brand colors from design-vibes (24-bit true color ANSI)
  const c = {
    reset: "\x1b[0m",
    bold: "\x1b[1m",
    dim: "\x1b[2m",
    white: "\x1b[97m",
    // design-vibes brand palette
    red: "\x1b[38;2;242;78;30m", // #F24E1E
    orange: "\x1b[38;2;255;114;98m", // #FF7262
    purple: "\x1b[38;2;162;89;255m", // #A259FF
    blue: "\x1b[38;2;26;188;254m", // #1ABCFE
    green: "\x1b[38;2;10;207;131m", // #0ACF83
  }
  const W = 62 // inner width (between ║ chars)
  // eslint-disable-next-line no-control-regex
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "")
  const pad = (s: string, w = W) =>
    s + " ".repeat(Math.max(0, w - strip(s).length))
  const line = (content: string) =>
    `${c.blue}║${c.reset} ${pad(content, W - 1)}${c.blue}║${c.reset}`
  const empty = line("")
  const sep = `${c.blue}╠${"═".repeat(W)}╣${c.reset}`

  const serverUrl = `${protocol}://localhost:${port}`

  // Funny Vibes ASCII Art Logo (design-vibes brand colors)
  const logo = [
    `${c.bold}${c.red} ███████╗${c.orange}██╗   ██╗${c.red}███╗   ██╗${c.orange}███╗   ██╗${c.red}██╗   ██╗${c.reset}`,
    `${c.bold}${c.red} ██╔════╝${c.orange}██║   ██║${c.red}████╗  ██║${c.orange}████╗  ██║${c.red}╚██╗ ██╔╝${c.reset}`,
    `${c.bold}${c.red} █████╗  ${c.orange}██║   ██║${c.red}██╔██╗ ██║${c.orange}██╔██╗ ██║${c.red} ╚████╔╝ ${c.reset}`,
    `${c.bold}${c.red} ██╔══╝  ${c.orange}██║   ██║${c.red}██║╚██╗██║${c.orange}██║╚██╗██║${c.red}  ╚██╔╝  ${c.reset}`,
    `${c.bold}${c.red} ██║     ${c.orange}╚██████╔╝${c.red}██║ ╚████║${c.orange}██║ ╚████║${c.red}   ██║   ${c.reset}`,
    `${c.bold}${c.red} ╚═╝     ${c.orange} ╚═════╝ ${c.red}╚═╝  ╚═══╝${c.orange}╚═╝  ╚═══╝${c.red}   ╚═╝   ${c.reset}`,
    `${c.bold}${c.blue}      ██╗   ██╗${c.green}██╗${c.blue}██████╗ ${c.green}███████╗${c.blue}███████╗${c.reset}`,
    `${c.bold}${c.blue}      ██║   ██║${c.green}██║${c.blue}██╔══██╗${c.green}██╔════╝${c.blue}██╔════╝${c.reset}`,
    `${c.bold}${c.blue}      ██║   ██║${c.green}██║${c.blue}██████╔╝${c.green}█████╗  ${c.blue}███████╗${c.reset}`,
    `${c.bold}${c.blue}      ╚██╗ ██╔╝${c.green}██║${c.blue}██╔══██╗${c.green}██╔══╝  ${c.blue}╚════██║${c.reset}`,
    `${c.bold}${c.blue}       ╚████╔╝ ${c.green}██║${c.blue}██████╔╝${c.green}███████╗${c.blue}███████║${c.reset}`,
    `${c.bold}${c.blue}        ╚═══╝  ${c.green}╚═╝${c.blue}╚═════╝ ${c.green}╚══════╝${c.blue}╚══════╝${c.reset}`,
  ]

  console.log(`
${c.dim}${"─".repeat(64)}${c.reset}
${logo.join("\n")}
${c.dim}${"─".repeat(64)}${c.reset}

${c.blue}╔${"═".repeat(W)}╗${c.reset}
${c.blue}║${c.reset}${pad("", Math.floor((W - 28) / 2))}${c.bold}${c.blue}⚡ Agent Vibes Proxy Server ⚡${c.reset}${pad("", Math.ceil((W - 28) / 2) - 1)}${c.blue}║${c.reset}
${sep}
${empty}
${line(`${c.green}▸${c.reset} Server    ${c.bold}${c.green}${serverUrl}${c.reset}`)}
${line(`${c.green}▸${c.reset} API Docs  ${c.bold}${c.green}${serverUrl}/docs${c.reset}`)}
${line(`${c.green}▸${c.reset} HTTP/2    ${c.bold}${c.white}${http2Status}${c.reset}`)}
${empty}
${line(`${c.orange}${c.bold}Anthropic API${c.reset} ${c.dim}(Claude Code CLI)${c.reset}`)}
${line(`  ${c.purple}POST${c.reset} /v1/messages ${c.dim}·· Anthropic Messages API${c.reset}`)}
${line(`  ${c.purple}GET ${c.reset} /v1/models   ${c.dim}·· List available models${c.reset}`)}
${empty}
${line(`${c.orange}${c.bold}Cursor gRPC${c.reset}   ${c.dim}(Cursor IDE)${c.reset}`)}
${line(`  ${c.purple}POST${c.reset} /agent.v1.*  ${c.dim}·· Agent mode endpoints${c.reset}`)}
${empty}
${line(`${c.orange}${c.bold}Health${c.reset}`)}
${line(`  ${c.purple}GET ${c.reset} /health      ${c.dim}·· Health check${c.reset}`)}
${empty}
${c.blue}╚${"═".repeat(W)}╝${c.reset}
`)
}

bootstrap().catch((error: unknown) => {
  console.error("Failed to start server:", error)
  process.exit(1)
})
