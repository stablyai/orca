// Enum vocabulary for macOS's own verdict at a confirmed terminal-host folder denial; no paths, pids or log text.

export const TCC_LOG_ACCESS_VALUES = ['ok', 'denied', 'timeout', 'error'] as const
export type TccLogAccess = (typeof TCC_LOG_ACCESS_VALUES)[number]

export const YES_NO_VALUES = ['yes', 'no'] as const
export type YesNo = (typeof YES_NO_VALUES)[number]

export const TCC_ASKED_VALUES = ['yes', 'no', 'unknown'] as const
export type TccAsked = (typeof TCC_ASKED_VALUES)[number]

// tccd authValue: 0 denied, 1 unknown, 2 allowed, 3 limited.
export const TCC_AUTH_VALUES = ['denied', 'unknown', 'allowed', 'limited', 'other', 'none'] as const
export type TccAuthValue = (typeof TCC_AUTH_VALUES)[number]

// Raw tccd authReason numbers; their meanings are not documented by Apple.
export const TCC_AUTH_REASONS = [
  '0',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  '10',
  '11',
  '12',
  'other',
  'none'
] as const
export type TccAuthReason = (typeof TCC_AUTH_REASONS)[number]

export const TCC_SERVICE_VALUES = [
  'documents',
  'desktop',
  'downloads',
  'all_files',
  'other',
  'none'
] as const
export type TccService = (typeof TCC_SERVICE_VALUES)[number]

export const SIGNATURE_CHECK_VALUES = ['pass', 'fail', 'error'] as const
export type SignatureCheck = (typeof SIGNATURE_CHECK_VALUES)[number]

export const HELPER_AGE_BUCKETS = [
  '<1m',
  '1-10m',
  '10-60m',
  '1-6h',
  '6-24h',
  '1-7d',
  '7d+',
  'unknown'
] as const
export type HelperAgeBucket = (typeof HELPER_AGE_BUCKETS)[number]

export const HELPER_ORIGIN_VALUES = ['adopted', 'spawned', 'unknown'] as const
export type HelperOrigin = (typeof HELPER_ORIGIN_VALUES)[number]

export const GOOD_READ_COUNT_BUCKETS = ['0', '1', '2-5', '6+'] as const
export type GoodReadCountBucket = (typeof GOOD_READ_COUNT_BUCKETS)[number]

export const ELAPSED_BUCKETS = [
  'never',
  '<10s',
  '10-60s',
  '1-5m',
  '5-30m',
  '30m-6h',
  '6h+'
] as const
export type ElapsedBucket = (typeof ELAPSED_BUCKETS)[number]

export const FULL_DISK_ACCESS_VALUES = ['granted', 'denied', 'unsupported', 'unknown'] as const
export type FullDiskAccessValue = (typeof FULL_DISK_ACCESS_VALUES)[number]

export const FORK_FALLBACK_VALUES = [
  'none',
  'prepare-failed',
  'deadline',
  'bootstrap-refused',
  'exited-before-ready',
  'endpoint-taken',
  'os-too-old',
  'not-eligible',
  'unknown'
] as const
export type ForkFallbackValue = (typeof FORK_FALLBACK_VALUES)[number]

export const FOLDER_FLAG_VALUES = ['yes', 'no', 'unknown'] as const
export type FolderFlag = (typeof FOLDER_FLAG_VALUES)[number]

export const ICLOUD_MANAGED_VALUES = ['yes', 'no', 'unknown', 'not_applicable'] as const
export type IcloudManaged = (typeof ICLOUD_MANAGED_VALUES)[number]

export const VOLUME_TYPE_VALUES = [
  'apfs',
  'hfs',
  'smbfs',
  'nfs',
  'afpfs',
  'webdav',
  'msdos',
  'exfat',
  'other',
  'unknown'
] as const
export type VolumeType = (typeof VOLUME_TYPE_VALUES)[number]

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS

export function bucketHelperAge(ageMs: number | null): HelperAgeBucket {
  if (ageMs === null || !Number.isFinite(ageMs) || ageMs < 0) {
    return 'unknown'
  }
  if (ageMs < MINUTE_MS) {
    return '<1m'
  }
  if (ageMs < 10 * MINUTE_MS) {
    return '1-10m'
  }
  if (ageMs < HOUR_MS) {
    return '10-60m'
  }
  if (ageMs < 6 * HOUR_MS) {
    return '1-6h'
  }
  if (ageMs < 24 * HOUR_MS) {
    return '6-24h'
  }
  return ageMs < 7 * 24 * HOUR_MS ? '1-7d' : '7d+'
}

export function bucketElapsed(elapsedMs: number | null): ElapsedBucket {
  if (elapsedMs === null || !Number.isFinite(elapsedMs) || elapsedMs < 0) {
    return 'never'
  }
  if (elapsedMs < 10_000) {
    return '<10s'
  }
  if (elapsedMs < MINUTE_MS) {
    return '10-60s'
  }
  if (elapsedMs < 5 * MINUTE_MS) {
    return '1-5m'
  }
  if (elapsedMs < 30 * MINUTE_MS) {
    return '5-30m'
  }
  return elapsedMs < 6 * HOUR_MS ? '30m-6h' : '6h+'
}

export function bucketGoodReadCount(count: number): GoodReadCountBucket {
  if (count <= 0) {
    return '0'
  }
  if (count === 1) {
    return '1'
  }
  return count <= 5 ? '2-5' : '6+'
}
