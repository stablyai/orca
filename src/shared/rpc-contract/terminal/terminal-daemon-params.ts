import { z } from 'zod'

export const TerminalDaemonKillOneParams = z.object({
  sessionId: z.string().min(1).max(256)
})
export type TerminalDaemonKillOneParams = z.infer<typeof TerminalDaemonKillOneParams>

export const TerminalDaemonRestartSeveredParams = z.object({
  pid: z.number().int().positive(),
  linuxStartTicks: z.string().min(1).max(32),
  bootId: z.string().min(1).max(64)
})
