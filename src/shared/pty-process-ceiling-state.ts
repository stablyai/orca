import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** What a daemon reports about its terminal process ceiling; additive in the pid record and health. */
export type PtyProcessCeilingOffReason =
  | 'disabled'
  | 'invalid_limit'
  | 'unsupported_platform'
  | 'no_user_manager'
  | 'slice_unavailable'
  | 'systemd_run_missing'
  | 'controller_unavailable'
  | 'slice_lost'
  | 'native_unavailable'

export type PtyProcessCeilingState =
  | {
      state: 'on'
      limit: number
      mechanism: 'systemd-slice' | 'windows-job'
      unit: string | null
      /** The slice's cgroup, so any reader on the host can confirm it still exists. */
      controlGroup?: string
    }
  | { state: 'off'; reason: PtyProcessCeilingOffReason }

const OFF_REASONS: readonly PtyProcessCeilingOffReason[] = [
  'disabled',
  'invalid_limit',
  'unsupported_platform',
  'no_user_manager',
  'slice_unavailable',
  'systemd_run_missing',
  'controller_unavailable',
  'slice_lost',
  'native_unavailable'
]

export function parsePtyProcessCeilingState(value: unknown): PtyProcessCeilingState | null {
  if (typeof value !== 'object' || value === null || !('state' in value)) {
    return null
  }
  if (value.state === 'off') {
    const reason =
      'reason' in value ? OFF_REASONS.find((entry) => entry === value.reason) : undefined
    return reason ? { state: 'off', reason } : null
  }
  if (
    value.state === 'on' &&
    'limit' in value &&
    typeof value.limit === 'number' &&
    'mechanism' in value &&
    (value.mechanism === 'systemd-slice' || value.mechanism === 'windows-job')
  ) {
    const unit = 'unit' in value && typeof value.unit === 'string' ? value.unit : null
    const controlGroup =
      'controlGroup' in value && typeof value.controlGroup === 'string' ? value.controlGroup : null
    return {
      state: 'on',
      limit: value.limit,
      mechanism: value.mechanism,
      unit,
      ...(controlGroup ? { controlGroup } : {})
    }
  }
  return null
}

export function describePtyProcessCeiling(state: PtyProcessCeilingState | null): string {
  if (!state) {
    return 'not reported'
  }
  return state.state === 'on'
    ? `on (${state.limit} processes, ${state.mechanism === 'systemd-slice' ? `per terminal, systemd ${state.unit ?? 'slice'}` : 'requested per terminal job'})`
    : `off (${state.reason.replace(/_/g, ' ')})`
}

/**
 * A report read later: a restarted user manager drops the transient slice, after which new
 * terminals run without a limit, so a slice that is gone is reported as lost, never as on.
 */
export function confirmPtyProcessCeiling(
  state: PtyProcessCeilingState | null,
  exists: (path: string) => boolean = existsSync
): PtyProcessCeilingState | null {
  if (state?.state !== 'on' || state.mechanism !== 'systemd-slice' || !state.controlGroup) {
    return state
  }
  return exists(join('/sys/fs/cgroup', state.controlGroup, 'pids.max'))
    ? state
    : { state: 'off', reason: 'slice_lost' }
}
