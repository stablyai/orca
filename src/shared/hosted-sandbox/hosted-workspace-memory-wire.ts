import { z } from 'zod'

/**
 * MEMGUARD: memory pressure in a cloud VM and the processes its memory guard stopped this boot
 * (kernel OOM kills stay in the status's `metrics.oomKills`). Pressure without a guard (an older
 * image) comes from MemAvailable alone, and `guarded` is false.
 */
export const HostedWorkspaceMemorySchema = z
  .object({
    pressure: z.enum(['ok', 'high', 'critical']),
    guardKills: z.number().int().nonnegative(),
    lastGuardVictim: z.string().max(64).nullable(),
    lastGuardKillAt: z.number().int().nonnegative().nullable(),
    guarded: z.boolean()
  })
  .strip()
export type HostedWorkspaceMemory = z.infer<typeof HostedWorkspaceMemorySchema>
