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

/** Why optional: a client that predates it sends nothing and keeps the host-default probe. */
export const PreflightAgentDetection = z.object({
  worktreeId: z.string().min(1).optional()
})
