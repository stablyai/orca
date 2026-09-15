import { z } from 'zod'

export const PreflightCheck = z.object({
  force: z.boolean().optional()
})

export const PreflightDetectRemoteAgents = z.object({
  connectionId: z.string().min(1)
})

export const PreflightDetectRemoteWindowsTerminalCapabilities = z.object({
  connectionId: z.string().min(1)
})

export const PreflightAgentHealthProvider = z.object({
  provider: z.enum(['claude', 'codex'])
})
