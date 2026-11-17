import { z } from 'zod'

// The VM's live metrics (status panel, OOM banner), parsed strictly: a field a desktop doesn't know
// fails the read, so new VM facts go beside it (like `memory`), not in it.
const Bytes = z.number().int().nonnegative()
export const HostedVmMetricsSchema = z
  .object({
    cpuPercent: z.number().int().min(0).max(100),
    cpus: z.number().int().min(1),
    load1: z.number().min(0),
    memTotalBytes: Bytes,
    memUsedBytes: Bytes,
    diskTotalBytes: Bytes,
    diskUsedBytes: Bytes,
    uptimeSeconds: z.number().int().nonnegative(),
    oomKills: z.number().int().nonnegative(),
    lastOomVictim: z.string().max(64).nullable(),
    orcadAlive: z.boolean()
  })
  .strict()
export type HostedVmMetrics = z.infer<typeof HostedVmMetricsSchema>

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
