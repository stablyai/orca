import type {
  NestedRepoScanResult,
  ProjectGroupImportMode,
  ProjectGroupImportResult
} from './types'

export const NESTED_REPO_TELEMETRY_MAX_REPO_COUNT = 500

export const NESTED_REPO_TELEMETRY_SURFACES = ['onboarding', 'sidebar'] as const
export type NestedRepoTelemetrySurface = (typeof NESTED_REPO_TELEMETRY_SURFACES)[number]

export const NESTED_REPO_TELEMETRY_RUNTIME_KINDS = ['local', 'runtime', 'ssh'] as const
export type NestedRepoTelemetryRuntimeKind = (typeof NESTED_REPO_TELEMETRY_RUNTIME_KINDS)[number]

export const NESTED_REPO_SCAN_RESULTS = [
  'review_shown',
  'git_repo',
  'no_nested_repos',
  'scan_failed'
] as const
export type NestedRepoScanTelemetryResult = (typeof NESTED_REPO_SCAN_RESULTS)[number]

export const NESTED_REPO_IMPORT_ACTIONS = ['import_group', 'import_separate', 'back'] as const
export type NestedRepoImportTelemetryAction = (typeof NESTED_REPO_IMPORT_ACTIONS)[number]

export const NESTED_REPO_IMPORT_OUTCOMES = ['success', 'partial_failure', 'failed'] as const
export type NestedRepoImportTelemetryOutcome = (typeof NESTED_REPO_IMPORT_OUTCOMES)[number]

export const NESTED_REPO_COUNT_BUCKETS = ['0', '1', '2-3', '4-7', '8-15', '16+'] as const
export type NestedRepoCountBucket = (typeof NESTED_REPO_COUNT_BUCKETS)[number]

type NestedRepoTelemetryBase = {
  attempt_id: string
  surface: NestedRepoTelemetrySurface
  runtime_kind: NestedRepoTelemetryRuntimeKind
}

export type NestedRepoScanTelemetry = NestedRepoTelemetryBase & {
  result: NestedRepoScanTelemetryResult
  selected_path_kind?: NestedRepoScanResult['selectedPathKind']
  found_count: number
  found_count_bucket: NestedRepoCountBucket
  truncated: boolean
  timed_out: boolean
}

export type NestedRepoImportActionTelemetry = NestedRepoTelemetryBase & {
  action: NestedRepoImportTelemetryAction
  found_count: number
  found_count_bucket: NestedRepoCountBucket
  selected_count: number
  selected_count_bucket: NestedRepoCountBucket
  all_selected: boolean
}

export type NestedRepoImportResultTelemetry = NestedRepoTelemetryBase & {
  mode: ProjectGroupImportMode
  outcome: NestedRepoImportTelemetryOutcome
  found_count: number
  found_count_bucket: NestedRepoCountBucket
  selected_count: number
  selected_count_bucket: NestedRepoCountBucket
  imported_count: number
  imported_count_bucket: NestedRepoCountBucket
  already_known_count: number
  already_known_count_bucket: NestedRepoCountBucket
  failed_count: number
  failed_count_bucket: NestedRepoCountBucket
  all_selected: boolean
}

export function capNestedRepoTelemetryCount(count: number): number {
  if (!Number.isFinite(count)) {
    return 0
  }
  return Math.max(0, Math.min(NESTED_REPO_TELEMETRY_MAX_REPO_COUNT, Math.floor(count)))
}

function normalizeNestedRepoTelemetryCount(count: number): number {
  if (!Number.isFinite(count)) {
    return 0
  }
  return Math.max(0, Math.floor(count))
}

export function bucketNestedRepoTelemetryCount(count: number): NestedRepoCountBucket {
  const capped = capNestedRepoTelemetryCount(count)
  if (capped === 0) {
    return '0'
  }
  if (capped === 1) {
    return '1'
  }
  if (capped <= 3) {
    return '2-3'
  }
  if (capped <= 7) {
    return '4-7'
  }
  if (capped <= 15) {
    return '8-15'
  }
  return '16+'
}

export function shouldEmitNestedRepoImportSubmitTelemetry(args: {
  attemptId: string | null
  selectedCount: number
  isBusy?: boolean
}): boolean {
  return Boolean(args.attemptId && args.selectedCount > 0 && !args.isBusy)
}

export function createNestedRepoTelemetryAttemptId(): string {
  const cryptoApi = globalThis.crypto
  if (typeof cryptoApi?.randomUUID === 'function') {
    return cryptoApi.randomUUID()
  }

  const bytes = new Uint8Array(16)
  if (typeof cryptoApi?.getRandomValues === 'function') {
    cryptoApi.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256)
    }
  }

  // Why: keep the fallback schema-compatible without deriving from any stable repo input.
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'))
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`
}

export function buildNestedRepoScanTelemetry(args: {
  attemptId: string
  surface: NestedRepoTelemetrySurface
  runtimeKind: NestedRepoTelemetryRuntimeKind
  scan: NestedRepoScanResult | null
}): NestedRepoScanTelemetry {
  const foundCount = capNestedRepoTelemetryCount(args.scan?.repos.length ?? 0)
  const result: NestedRepoScanTelemetryResult =
    args.scan === null
      ? 'scan_failed'
      : args.scan.selectedPathKind === 'git_repo'
        ? 'git_repo'
        : foundCount > 0
          ? 'review_shown'
          : 'no_nested_repos'

  return {
    attempt_id: args.attemptId,
    surface: args.surface,
    runtime_kind: args.runtimeKind,
    result,
    ...(args.scan ? { selected_path_kind: args.scan.selectedPathKind } : {}),
    found_count: foundCount,
    found_count_bucket: bucketNestedRepoTelemetryCount(foundCount),
    truncated: args.scan?.truncated ?? false,
    timed_out: args.scan?.timedOut ?? false
  }
}

export function buildNestedRepoImportActionTelemetry(args: {
  attemptId: string
  surface: NestedRepoTelemetrySurface
  runtimeKind: NestedRepoTelemetryRuntimeKind
  action: NestedRepoImportTelemetryAction
  foundCount: number
  selectedCount: number
}): NestedRepoImportActionTelemetry {
  const rawFoundCount = normalizeNestedRepoTelemetryCount(args.foundCount)
  const rawSelectedCount = normalizeNestedRepoTelemetryCount(args.selectedCount)
  const foundCount = capNestedRepoTelemetryCount(args.foundCount)
  const selectedCount = capNestedRepoTelemetryCount(args.selectedCount)
  return {
    attempt_id: args.attemptId,
    surface: args.surface,
    runtime_kind: args.runtimeKind,
    action: args.action,
    found_count: foundCount,
    found_count_bucket: bucketNestedRepoTelemetryCount(foundCount),
    selected_count: selectedCount,
    selected_count_bucket: bucketNestedRepoTelemetryCount(selectedCount),
    all_selected: rawFoundCount > 0 && rawSelectedCount === rawFoundCount
  }
}

export function buildNestedRepoImportResultTelemetry(args: {
  attemptId: string
  surface: NestedRepoTelemetrySurface
  runtimeKind: NestedRepoTelemetryRuntimeKind
  mode: ProjectGroupImportMode
  foundCount: number
  selectedCount: number
  result: ProjectGroupImportResult | null
}): NestedRepoImportResultTelemetry {
  const rawFoundCount = normalizeNestedRepoTelemetryCount(args.foundCount)
  const rawSelectedCount = normalizeNestedRepoTelemetryCount(args.selectedCount)
  const foundCount = capNestedRepoTelemetryCount(args.foundCount)
  const selectedCount = capNestedRepoTelemetryCount(args.selectedCount)
  const importedCount = capNestedRepoTelemetryCount(args.result?.importedCount ?? 0)
  const alreadyKnownCount = capNestedRepoTelemetryCount(args.result?.alreadyKnownCount ?? 0)
  const failedCount = capNestedRepoTelemetryCount(args.result?.failedCount ?? selectedCount)
  const acceptedCount = importedCount + alreadyKnownCount
  const outcome: NestedRepoImportTelemetryOutcome =
    acceptedCount === 0 ? 'failed' : failedCount > 0 ? 'partial_failure' : 'success'

  return {
    attempt_id: args.attemptId,
    surface: args.surface,
    runtime_kind: args.runtimeKind,
    mode: args.mode,
    outcome,
    found_count: foundCount,
    found_count_bucket: bucketNestedRepoTelemetryCount(foundCount),
    selected_count: selectedCount,
    selected_count_bucket: bucketNestedRepoTelemetryCount(selectedCount),
    imported_count: importedCount,
    imported_count_bucket: bucketNestedRepoTelemetryCount(importedCount),
    already_known_count: alreadyKnownCount,
    already_known_count_bucket: bucketNestedRepoTelemetryCount(alreadyKnownCount),
    failed_count: failedCount,
    failed_count_bucket: bucketNestedRepoTelemetryCount(failedCount),
    all_selected: rawFoundCount > 0 && rawSelectedCount === rawFoundCount
  }
}
