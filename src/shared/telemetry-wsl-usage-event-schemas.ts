import { z } from 'zod'

// Counts only ever leave as these buckets, so a payload can't single out an install by an exact tally.
export const WSL_USAGE_COUNT_BUCKETS = ['0', '1', '2-5', '6-20', '21+'] as const
export type WslUsageCountBucket = (typeof WSL_USAGE_COUNT_BUCKETS)[number]

export function bucketWslUsageCount(count: number): WslUsageCountBucket {
  if (count <= 0) {
    return '0'
  }
  if (count === 1) {
    return '1'
  }
  if (count <= 5) {
    return '2-5'
  }
  return count <= 20 ? '6-20' : '21+'
}

const countBucketSchema = z.enum(WSL_USAGE_COUNT_BUCKETS)

// Daily, Windows-only aggregate of WSL adoption. No paths, distro names, or repo names by design.
export const wslUsageSnapshotSchema = z
  .object({
    wsl_installed: z.boolean(),
    /** WSL package major.minor from its MSI registration; omitted for inbox/Store WSL or unreadable. */
    wsl_version: z
      .string()
      .regex(/^\d{1,3}\.\d{1,3}$/)
      .optional(),
    /** False when the distro registry could not be read, so the distro buckets mean "unknown", not 0. */
    distro_registry_readable: z.boolean(),
    distros_installed: countBucketSchema,
    distros_running: countBucketSchema,
    distros_wsl1: countBucketSchema,
    distros_wsl2: countBucketSchema,
    projects_wsl_total: countBucketSchema,
    projects_wsl_distro_fs: countBucketSchema,
    projects_wsl_windows_drive: countBucketSchema,
    projects_wsl_git: countBucketSchema,
    projects_wsl_folder: countBucketSchema,
    project_distros_used: countBucketSchema,
    wsl_hosts_gate_open: z.boolean()
  })
  .strict()

export type WslUsageSnapshotProps = z.infer<typeof wslUsageSnapshotSchema>
