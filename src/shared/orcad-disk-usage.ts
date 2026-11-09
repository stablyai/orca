// orcad's disk usage probe and the low-disk thresholds the desktop banner reads it against.
import { z } from 'zod'

/** orcad: free space on the filesystems holding workspaces, repos and $HOME. Read-only, no subprocess. */
export const ORCAD_DISK_USAGE_METHOD = 'orcad.diskUsage'
export const OrcadDiskUsageParamsSchema = z.object({}).strict()

export const OrcadDiskVolumeUsageSchema = z.object({
  /** A probed path on this filesystem (the first one that resolved to it). */
  path: z.string(),
  totalBytes: z.number().nonnegative(),
  freeBytes: z.number().nonnegative(),
  /** Free bytes an unprivileged process may use (excludes root-reserved blocks). */
  availableBytes: z.number().nonnegative(),
  /** 0-100, from total and available, matching `df`'s Use%. */
  usedPercent: z.number().min(0).max(100)
})
export type OrcadDiskVolumeUsage = z.infer<typeof OrcadDiskVolumeUsageSchema>

export const OrcadDiskUsageResultSchema = z.object({
  /** One entry per distinct filesystem; the workspace root's comes first. */
  volumes: z.array(OrcadDiskVolumeUsageSchema),
  checkedAt: z.number()
})
export type OrcadDiskUsageResult = z.infer<typeof OrcadDiskUsageResultSchema>

const MIB = 1024 * 1024
const GIB = 1024 * MIB

/** Warn under 10% or 2 GiB available; critical under 500 MiB, where builds and git start failing. */
export const LOW_DISK_WARNING_FRACTION = 0.1
export const LOW_DISK_WARNING_BYTES = 2 * GIB
export const LOW_DISK_CRITICAL_BYTES = 500 * MIB

export type LowDiskLevel = 'ok' | 'warning' | 'critical'

export function lowDiskLevelForVolume(
  volume: Pick<OrcadDiskVolumeUsage, 'totalBytes' | 'availableBytes'>
): LowDiskLevel {
  // A zero-size filesystem (procfs-like mount, failed statfs) carries no signal.
  if (volume.totalBytes <= 0) {
    return 'ok'
  }
  if (volume.availableBytes < LOW_DISK_CRITICAL_BYTES) {
    return 'critical'
  }
  if (
    volume.availableBytes < LOW_DISK_WARNING_BYTES ||
    volume.availableBytes < volume.totalBytes * LOW_DISK_WARNING_FRACTION
  ) {
    return 'warning'
  }
  return 'ok'
}

const LEVEL_RANK: Record<LowDiskLevel, number> = { ok: 0, warning: 1, critical: 2 }

/** The most severe volume, ties broken by least available space; null when every volume is fine. */
export function worstLowDiskVolume(
  volumes: readonly OrcadDiskVolumeUsage[]
): { level: Exclude<LowDiskLevel, 'ok'>; volume: OrcadDiskVolumeUsage } | null {
  let worst: { level: LowDiskLevel; volume: OrcadDiskVolumeUsage } | null = null
  for (const volume of volumes) {
    const level = lowDiskLevelForVolume(volume)
    if (level === 'ok') {
      continue
    }
    if (
      !worst ||
      LEVEL_RANK[level] > LEVEL_RANK[worst.level] ||
      (level === worst.level && volume.availableBytes < worst.volume.availableBytes)
    ) {
      worst = { level, volume }
    }
  }
  return worst && worst.level !== 'ok' ? { level: worst.level, volume: worst.volume } : null
}
