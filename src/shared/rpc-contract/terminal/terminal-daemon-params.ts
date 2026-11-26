import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'

export const TerminalDaemonRestartSeveredParams = lazyZodSchema(() =>
  z.object({
    pid: z.number().int().positive(),
    linuxStartTicks: z.string().min(1).max(32),
    bootId: z.string().min(1).max(64)
  })
)
