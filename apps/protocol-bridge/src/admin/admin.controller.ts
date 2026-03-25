import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common"
import { ApiOperation, ApiTags } from "@nestjs/swagger"
import { ApiKeyGuard } from "../shared/api-key.guard"
import { AdminService } from "./admin.service"
import { NativeAccount } from "../llm/native/process-pool.service"

@ApiTags("Admin")
@Controller("admin")
@UseGuards(ApiKeyGuard)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  // =========================================================================
  // Accounts
  // =========================================================================

  @Get("accounts")
  @ApiOperation({ summary: "List all Antigravity accounts" })
  getAccounts() {
    return this.adminService.getAccounts()
  }

  @Post("accounts")
  @ApiOperation({ summary: "Add or update an account" })
  addAccount(@Body() account: NativeAccount) {
    return this.adminService.addAccount(account)
  }

  @Delete("accounts/:email")
  @ApiOperation({ summary: "Delete an account by email" })
  deleteAccount(@Param("email") email: string) {
    return this.adminService.deleteAccount(decodeURIComponent(email))
  }

  @Post("accounts/import")
  @ApiOperation({ summary: "Import multiple accounts (merge)" })
  importAccounts(@Body() body: { accounts: NativeAccount[] }) {
    return this.adminService.importAccounts(body.accounts || [])
  }

  @Get("accounts/export")
  @ApiOperation({ summary: "Export all accounts as JSON" })
  exportAccounts() {
    return this.adminService.getAccounts()
  }

  // =========================================================================
  // Settings
  // =========================================================================

  @Get("settings")
  @ApiOperation({ summary: "Get current .env.local settings" })
  getSettings() {
    return this.adminService.getSettings()
  }

  @Put("settings")
  @ApiOperation({ summary: "Update .env.local settings" })
  updateSettings(@Body() updates: Record<string, string>) {
    return this.adminService.updateSettings(updates)
  }

  // =========================================================================
  // Request Logs
  // =========================================================================

  @Get("logs")
  @ApiOperation({ summary: "Get recent request logs" })
  getLogs(@Query("limit") limit?: string) {
    const n = limit ? parseInt(limit, 10) : 50
    return this.adminService.getRequestLogs(isNaN(n) ? 50 : n)
  }

  // =========================================================================
  // System
  // =========================================================================

  @Get("system")
  @ApiOperation({ summary: "Get system info (uptime, memory, etc.)" })
  getSystemInfo() {
    return this.adminService.getSystemInfo()
  }
}
