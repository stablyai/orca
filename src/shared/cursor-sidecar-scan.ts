import { posix, win32 } from 'node:path'
import { z } from 'zod'

export const CURSOR_SIDECAR_SCAN_VERSION = 1 as const
export const CURSOR_SIDECAR_MAX_BYTES = 262_144
export const CURSOR_REMOTE_MAX_AGGREGATE_BYTES = 16_777_216
export const CURSOR_REMOTE_MAX_BUCKETS = 256
export const CURSOR_REMOTE_MAX_SCOPE_PATHS = 64
export const CURSOR_REMOTE_MAX_SESSION_DIRS = 2_000

const positiveSafeInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const finiteNonnegativeNumber = z.number().finite().nonnegative()
const boundedPath = z.string().min(1).max(32_768)
const safeSessionBasename = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => value !== '.' && value !== '..' && !/[\\/]/u.test(value))

export const cursorSidecarScanRequestSchema = z
  .object({
    version: z.literal(CURSOR_SIDECAR_SCAN_VERSION),
    chatsRoot: boundedPath,
    scopePaths: z.array(boundedPath).max(CURSOR_REMOTE_MAX_SCOPE_PATHS),
    maxBuckets: positiveSafeInteger.max(CURSOR_REMOTE_MAX_BUCKETS),
    maxSessionDirs: positiveSafeInteger.max(CURSOR_REMOTE_MAX_SESSION_DIRS),
    maxScopePaths: positiveSafeInteger.max(CURSOR_REMOTE_MAX_SCOPE_PATHS),
    maxSidecarBytes: positiveSafeInteger.max(CURSOR_SIDECAR_MAX_BYTES),
    maxAggregateBytes: positiveSafeInteger.max(CURSOR_REMOTE_MAX_AGGREGATE_BYTES)
  })
  .strict()

const cursorSidecarScanItemSchema = z
  .object({
    bucket: z.string().regex(/^[0-9a-f]{32}$/u),
    sessionId: safeSessionBasename,
    metaPath: boundedPath,
    content: z.string(),
    metaMtimeMs: finiteNonnegativeNumber,
    metaSizeBytes: finiteNonnegativeNumber,
    storeMtimeMs: finiteNonnegativeNumber,
    scopeCwd: boundedPath.nullable()
  })
  .strict()
  .superRefine((item, context) => {
    if (utf8ByteLength(item.content) > CURSOR_SIDECAR_MAX_BYTES) {
      context.addIssue({ code: 'custom', message: 'Cursor sidecar exceeds the byte cap.' })
    }
  })

const cursorSidecarScanCountersSchema = z
  .object({
    rootReaddir: z.number().int().nonnegative(),
    bucketReaddir: z.number().int().nonnegative(),
    fileLstat: z.number().int().nonnegative(),
    boundedReads: z.number().int().nonnegative(),
    scopeRealpath: z.number().int().nonnegative(),
    returnedBytes: z.number().int().nonnegative(),
    elapsedMs: finiteNonnegativeNumber
  })
  .strict()

const cursorSidecarScanTruncationSchema = z
  .object({
    scopePaths: z.boolean(),
    buckets: z.boolean(),
    sessionDirs: z.boolean(),
    sidecarBytes: z.boolean()
  })
  .strict()

const cursorSidecarScanIssueSchema = z
  .object({
    path: boundedPath,
    message: z.string().min(1).max(1_024)
  })
  .strict()

export const cursorSidecarScanResponseSchema = z
  .object({
    version: z.literal(CURSOR_SIDECAR_SCAN_VERSION),
    scopeCwds: z.array(boundedPath).max(CURSOR_REMOTE_MAX_SCOPE_PATHS * 6),
    sidecars: z.array(cursorSidecarScanItemSchema).max(CURSOR_REMOTE_MAX_SESSION_DIRS),
    issues: z
      .array(cursorSidecarScanIssueSchema)
      .max(
        CURSOR_REMOTE_MAX_SESSION_DIRS +
          CURSOR_REMOTE_MAX_BUCKETS +
          CURSOR_REMOTE_MAX_SCOPE_PATHS * 6 +
          8
      ),
    counters: cursorSidecarScanCountersSchema,
    truncated: cursorSidecarScanTruncationSchema
  })
  .strict()
  .superRefine((response, context) => {
    const totalBytes = response.sidecars.reduce(
      (total, sidecar) => total + utf8ByteLength(sidecar.content),
      0
    )
    if (
      totalBytes > CURSOR_REMOTE_MAX_AGGREGATE_BYTES ||
      totalBytes !== response.counters.returnedBytes
    ) {
      context.addIssue({ code: 'custom', message: 'Invalid Cursor sidecar byte total.' })
    }
  })

export type CursorSidecarScanRequest = z.infer<typeof cursorSidecarScanRequestSchema>
export type CursorSidecarScanResponse = z.infer<typeof cursorSidecarScanResponseSchema>

export function defaultCursorSidecarScanRequest(
  chatsRoot: string,
  scopePaths: readonly string[],
  platform: NodeJS.Platform
): CursorSidecarScanRequest {
  return {
    version: CURSOR_SIDECAR_SCAN_VERSION,
    chatsRoot,
    scopePaths: normalizeCursorRemoteScopePaths(scopePaths, platform),
    maxBuckets: CURSOR_REMOTE_MAX_BUCKETS,
    maxSessionDirs: CURSOR_REMOTE_MAX_SESSION_DIRS,
    maxScopePaths: CURSOR_REMOTE_MAX_SCOPE_PATHS,
    maxSidecarBytes: CURSOR_SIDECAR_MAX_BYTES,
    maxAggregateBytes: CURSOR_REMOTE_MAX_AGGREGATE_BYTES
  }
}

export function normalizeCursorRemoteScopePaths(
  values: readonly string[],
  platform: NodeJS.Platform
): string[] {
  return normalizedCursorRemoteScopePaths(values, platform).slice(0, CURSOR_REMOTE_MAX_SCOPE_PATHS)
}

export function cursorRemoteScopePathsWereTruncated(
  values: readonly string[],
  platform: NodeJS.Platform
): boolean {
  return normalizedCursorRemoteScopePaths(values, platform).length > CURSOR_REMOTE_MAX_SCOPE_PATHS
}

function normalizedCursorRemoteScopePaths(
  values: readonly string[],
  platform: NodeJS.Platform
): string[] {
  const pathOps = platform === 'win32' ? win32 : posix
  return [
    ...new Set(
      values
        .map((value) => value.trim())
        .filter((value) => value.length > 0 && pathOps.isAbsolute(value))
        .map((value) => pathOps.resolve(value))
    )
  ].sort()
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}
