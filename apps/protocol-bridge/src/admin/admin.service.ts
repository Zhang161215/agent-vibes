import { Injectable, Logger } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import * as fs from "fs"
import * as path from "path"
import { NativeAccount } from "../llm/native/process-pool.service"

export interface RequestLogEntry {
  timestamp: string
  method: string
  url: string
  status: number
  duration: number
  userAgent?: string
  error?: string
}

export interface CodexInfo {
  available: boolean
  authMode: "apikey" | "oauth" | "none"
  hasApiKey: boolean
  hasAccessToken: boolean
  baseUrl: string
  hasProxy: boolean
  planType: string | null
  useWebSocket: boolean
}

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name)
  private readonly requestLogs: RequestLogEntry[] = []
  private readonly MAX_LOGS = 200

  constructor(private readonly configService: ConfigService) {}

  // =========================================================================
  // Accounts (Antigravity credentials)
  // =========================================================================

  private getAccountsFilePath(): string {
    const candidates = [
      path.resolve("data/accounts.json"),
      path.resolve("apps/protocol-bridge/data/accounts.json"),
    ]
    for (const p of candidates) {
      if (fs.existsSync(p)) return p
    }
    // Default to the first candidate for creation
    return candidates[0]!
  }

  getAccounts(): { accounts: NativeAccount[]; filePath: string } {
    const filePath = this.getAccountsFilePath()
    try {
      if (fs.existsSync(filePath)) {
        const data = JSON.parse(fs.readFileSync(filePath, "utf-8")) as {
          accounts?: NativeAccount[]
        }
        return {
          accounts: Array.isArray(data.accounts) ? data.accounts : [],
          filePath,
        }
      }
    } catch (err) {
      this.logger.warn(
        `Failed to read accounts: ${(err as Error).message}`
      )
    }
    return { accounts: [], filePath }
  }

  private saveAccounts(accounts: NativeAccount[]): void {
    const filePath = this.getAccountsFilePath()
    const dir = path.dirname(filePath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    fs.writeFileSync(
      filePath,
      JSON.stringify({ accounts }, null, 2),
      "utf-8"
    )
    this.logger.log(`Saved ${accounts.length} accounts to ${filePath}`)
  }

  addAccount(account: NativeAccount): { success: boolean; message: string } {
    const { accounts } = this.getAccounts()
    const existing = accounts.find((a) => a.email === account.email)
    if (existing) {
      // Update existing
      Object.assign(existing, account)
      this.saveAccounts(accounts)
      return { success: true, message: `Updated account: ${account.email}` }
    }
    accounts.push(account)
    this.saveAccounts(accounts)
    return { success: true, message: `Added account: ${account.email}` }
  }

  deleteAccount(email: string): { success: boolean; message: string } {
    const { accounts } = this.getAccounts()
    const index = accounts.findIndex((a) => a.email === email)
    if (index === -1) {
      return { success: false, message: `Account not found: ${email}` }
    }
    accounts.splice(index, 1)
    this.saveAccounts(accounts)
    return { success: true, message: `Deleted account: ${email}` }
  }

  importAccounts(
    newAccounts: NativeAccount[]
  ): { success: boolean; message: string; added: number; updated: number } {
    const { accounts } = this.getAccounts()
    let added = 0
    let updated = 0
    for (const acc of newAccounts) {
      const existing = accounts.find((a) => a.email === acc.email)
      if (existing) {
        Object.assign(existing, acc)
        updated++
      } else {
        accounts.push(acc)
        added++
      }
    }
    this.saveAccounts(accounts)
    return {
      success: true,
      message: `Imported ${added} new, ${updated} updated`,
      added,
      updated,
    }
  }

  // =========================================================================
  // Codex credentials info
  // =========================================================================

  getCodexInfo(): CodexInfo {
    const apiKey = (
      this.configService.get<string>("CODEX_API_KEY", "") || ""
    ).trim()
    const accessToken = (
      this.configService.get<string>("CODEX_ACCESS_TOKEN", "") || ""
    ).trim()
    const baseUrl = (
      this.configService.get<string>(
        "CODEX_BASE_URL",
        "https://chatgpt.com/backend-api/codex"
      ) || ""
    ).trim()
    const proxyUrl = (
      this.configService.get<string>("CODEX_PROXY_URL", "") || ""
    ).trim()
    const planType = (
      this.configService.get<string>("CODEX_PLAN_TYPE", "") || ""
    ).trim()
    const wsEnv = (
      this.configService.get<string>("CODEX_USE_WEBSOCKET", "") || ""
    )
      .trim()
      .toLowerCase()

    const hasApiKey = !!apiKey
    const hasAccessToken = !!accessToken

    return {
      available: hasApiKey || hasAccessToken,
      authMode: hasApiKey ? "apikey" : hasAccessToken ? "oauth" : "none",
      hasApiKey,
      hasAccessToken,
      baseUrl,
      hasProxy: !!proxyUrl,
      planType: planType || null,
      useWebSocket: wsEnv === "true" || wsEnv === "1",
    }
  }

  // =========================================================================
  // Settings (.env.local)
  // =========================================================================

  private getEnvFilePath(): string {
    const candidates = [
      path.resolve(".env.local"),
      path.resolve("apps/protocol-bridge/.env.local"),
    ]
    for (const p of candidates) {
      if (fs.existsSync(p)) return p
    }
    return candidates[0]!
  }

  getSettings(): { settings: Record<string, string>; filePath: string } {
    const filePath = this.getEnvFilePath()
    const settings: Record<string, string> = {}
    try {
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, "utf-8")
        for (const line of content.split("\n")) {
          const trimmed = line.trim()
          if (!trimmed || trimmed.startsWith("#")) continue
          const eqIndex = trimmed.indexOf("=")
          if (eqIndex === -1) continue
          const key = trimmed.substring(0, eqIndex).trim()
          let value = trimmed.substring(eqIndex + 1).trim()
          // Remove surrounding quotes
          if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
          ) {
            value = value.slice(1, -1)
          }
          settings[key] = value
        }
      }
    } catch (err) {
      this.logger.warn(
        `Failed to read settings: ${(err as Error).message}`
      )
    }
    return { settings, filePath }
  }

  updateSettings(
    updates: Record<string, string>
  ): { success: boolean; message: string } {
    const filePath = this.getEnvFilePath()
    let content = ""
    try {
      if (fs.existsSync(filePath)) {
        content = fs.readFileSync(filePath, "utf-8")
      }
    } catch {
      // File doesn't exist yet
    }

    const lines = content.split("\n")
    const updatedKeys = new Set<string>()

    // Update existing lines
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i]!.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const eqIndex = trimmed.indexOf("=")
      if (eqIndex === -1) continue
      const key = trimmed.substring(0, eqIndex).trim()
      if (key in updates) {
        lines[i] = `${key}=${updates[key]}`
        updatedKeys.add(key)
      }
    }

    // Add new keys that weren't in the file
    for (const [key, value] of Object.entries(updates)) {
      if (!updatedKeys.has(key)) {
        lines.push(`${key}=${value}`)
      }
    }

    fs.writeFileSync(filePath, lines.join("\n"), "utf-8")
    this.logger.log(
      `Updated settings: ${Object.keys(updates).join(", ")}`
    )
    return {
      success: true,
      message: `已更新 ${Object.keys(updates).length} 项设置，重启服务后生效。`,
    }
  }

  // =========================================================================
  // Request Logs (in-memory ring buffer)
  // =========================================================================

  addRequestLog(entry: RequestLogEntry): void {
    this.requestLogs.unshift(entry)
    if (this.requestLogs.length > this.MAX_LOGS) {
      this.requestLogs.length = this.MAX_LOGS
    }
  }

  getRequestLogs(limit = 50): RequestLogEntry[] {
    return this.requestLogs.slice(0, limit)
  }

  // =========================================================================
  // System Info
  // =========================================================================

  getSystemInfo(): Record<string, unknown> {
    const uptime = process.uptime()
    const memUsage = process.memoryUsage()
    return {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      uptime: {
        seconds: Math.floor(uptime),
        human: this.formatUptime(uptime),
      },
      memory: {
        rss: this.formatBytes(memUsage.rss),
        heapUsed: this.formatBytes(memUsage.heapUsed),
        heapTotal: this.formatBytes(memUsage.heapTotal),
      },
      pid: process.pid,
      cwd: process.cwd(),
    }
  }

  private formatUptime(seconds: number): string {
    const d = Math.floor(seconds / 86400)
    const h = Math.floor((seconds % 86400) / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    const s = Math.floor(seconds % 60)
    const parts: string[] = []
    if (d > 0) parts.push(`${d}天`)
    if (h > 0) parts.push(`${h}时`)
    if (m > 0) parts.push(`${m}分`)
    parts.push(`${s}秒`)
    return parts.join("")
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }
}
