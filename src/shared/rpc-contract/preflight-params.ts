import { z } from 'zod'

export const PreflightCheck = z.object({
  force: z.boolean().optional()
})

// Why: the Electron IPC twin of these methods carries a PreflightRuntimeContext, so a
// desktop WSL workspace probes inside its distro. Paired clients had no way to say that,
// leaving a Windows host to answer from its own PATH -- where a WSL-only install is absent.
export const PreflightDetectAgents = z.object({
  wslDistro: z.string().trim().min(1).max(255).optional(),
  wslDefault: z.boolean().optional()
})

export const PreflightDetectRemoteAgents = z.object({
  connectionId: z.string().min(1)
})

export const PreflightDetectRemoteWindowsTerminalCapabilities = z.object({
  connectionId: z.string().min(1)
})
