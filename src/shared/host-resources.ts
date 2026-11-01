import { z } from 'zod'

// A runtime that can answer `host.resources`. Older hosts omit it; the phone then asks for an update.
export const HOST_RESOURCES_RUNTIME_CAPABILITY = 'host.resources.v1' as const

export const HOST_RESOURCES_METHOD = 'host.resources' as const

const finiteNonNegative = z.number().refine((value) => Number.isFinite(value) && value >= 0)
const percent = z.number().refine((value) => Number.isFinite(value) && value >= 0 && value <= 100)
const byteCount = z.number().refine((value) => Number.isSafeInteger(value) && value >= 0)
const epochMs = z.number().refine((value) => Number.isSafeInteger(value) && value >= 0)

const swapSchema = z.object({
  usedBytes: byteCount,
  totalBytes: byteCount,
  usedPercent: percent
})

export const HostResourcesSnapshotSchema = z.object({
  sampledAt: epochMs,
  uptimeSeconds: finiteNonNegative,
  cpu: z.object({
    percent: percent.nullable(),
    coreCount: z.number().refine((value) => Number.isSafeInteger(value) && value >= 1),
    model: z.string(),
    loadAverage1m: finiteNonNegative.nullable(),
    cores: z.array(z.object({ percent: percent.nullable() }))
  }),
  memory: z.object({
    usedBytes: byteCount,
    totalBytes: byteCount,
    usedPercent: percent,
    swap: swapSchema.nullable()
  }),
  volumes: z.array(
    z.object({
      role: z.enum(['home', 'workspace', 'home-and-workspace']),
      usedBytes: byteCount,
      freeBytes: byteCount,
      totalBytes: byteCount,
      usedPercent: percent
    })
  )
})

export type HostResourcesSnapshot = z.output<typeof HostResourcesSnapshotSchema>
export type HostResourcesVolume = HostResourcesSnapshot['volumes'][number]

// Unknown fields are dropped. A payload that fails the shape is unusable, not a partial sample.
export function decodeHostResourcesSnapshot(value: unknown): HostResourcesSnapshot | null {
  const parsed = HostResourcesSnapshotSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
