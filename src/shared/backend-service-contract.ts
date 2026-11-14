import { z } from 'zod'
import type { RuntimeRpcResponse } from './runtime-rpc-envelope'
import type { AutomationRunUsage } from './automations/history/automation-run'

export const BACKEND_PORT_REQUEST = 'backend:connect'
export const BACKEND_PORT_DELIVERY = 'backend:port'
export const BACKEND_CONNECTION_CHANGED = 'backend:connectionChanged'
export const BACKEND_UTILITY_PROCESS_NAME = 'Orca backend'

export type BackendConnectionPurpose = 'demand' | 'recovery'
export type BackendConnectionStatus = { connected: boolean; unavailable?: boolean }
export type BackendConnectionDetail = { initial?: boolean; unavailable?: boolean }
export type BackendConnectionListener = (
  connected: boolean,
  detail?: BackendConnectionDetail
) => void

export const UsageProviderSchema = z.enum([
  'claudeUsage',
  'codexUsage',
  'openCodeUsage',
  'museUsage'
])
export type UsageProviderKey = z.infer<typeof UsageProviderSchema>
export const UsageActionSchema = z.enum([
  'getScanState',
  'setEnabled',
  'refresh',
  'getSnapshot',
  'getSummary',
  'getDaily',
  'getBreakdown',
  'getRecentSessions'
])
export type UsageAction = z.infer<typeof UsageActionSchema>
export type BackendResponse = RuntimeRpcResponse<unknown>

export const BackendBootstrapSchema = z
  .object({
    protocol: z.literal(1),
    requiredCapabilities: z.array(z.string().max(128)).max(32),
    services: z.tuple([z.literal('usage')]),
    build: z.string().max(256),
    paths: z.object({
      userData: z.string().min(1)
    }),
    appPath: z.string().min(1),
    isPackaged: z.boolean()
  })
  .strip()
export type BackendBootstrap = z.infer<typeof BackendBootstrapSchema>
export const BACKEND_CAPABILITIES = [
  'usage',
  'usage.catalog',
  'usage.claudeProfileDirs',
  'usage.accountRoots',
  'usage.telemetry'
] as const

export const BackendRequestSchema = z
  .object({
    id: z.string().min(1).max(128),
    method: z.string().min(1).max(128),
    params: z.unknown().optional()
  })
  .strip()

export type AutomationUsageInput = {
  worktreeId: string | null
  terminalSessionId: string | null
  startedAt: number | null
  completedAt: number | null
}
export type AutomationUsageClient = {
  getAutomationRunUsage(input: AutomationUsageInput): Promise<AutomationRunUsage>
}
