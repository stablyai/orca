import { z } from 'zod'
import type { RuntimeRpcResponse } from '../remote-runtime/rpc/runtime-rpc-envelope'
import type { AutomationRunUsage } from '../automations/history/automation-run'

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
/** A renderer-privileged usage call (`<provider>:<action>`); the usage service rejects anything else. */
export const UsageCallParams = z.object({
  method: z.string().min(1).max(128),
  params: z.unknown().optional()
})
export type UsageCall = z.infer<typeof UsageCallParams>
export const BACKEND_PUBLIC_USAGE_METHOD = 'usage.public'
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
    isPackaged: z.boolean(),
    // Linux only: lets the backend stop once main is gone.
    desktopOwner: z
      .object({
        pid: z.number().int().positive(),
        startTicks: z.string().regex(/^\d{1,20}$/),
        pidNamespace: z.string().min(1).max(64)
      })
      .optional()
  })
  .strip()
export type BackendBootstrap = z.infer<typeof BackendBootstrapSchema>
export type BackendDesktopOwner = NonNullable<BackendBootstrap['desktopOwner']>
export const BACKEND_CAPABILITIES = [
  'usage',
  'usage.catalog',
  'usage.claudeProfileDirs',
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
