/** The words of a distro's move status line (D3a-2); null where the line shows nothing. */
import { translate } from '@/i18n/i18n'
import type { WslMoveOrchestratorRecord } from '../../../../shared/wsl-move/wsl-move-orchestrator-types'

export type WslMoveOrchestratorLine =
  | { kind: 'deferred'; text: string }
  | { kind: 'stuck'; text: string }
  | { kind: 'declined'; text: string }
  | { kind: 'paused'; text: string }

export function wslMoveOrchestratorLine(
  record: WslMoveOrchestratorRecord | undefined
): WslMoveOrchestratorLine | null {
  const state = record?.state
  if (!record || !state) {
    return null
  }
  if (state.kind === 'deferred') {
    return {
      kind: 'deferred',
      text: translate(
        'wslMove.orchestrator.deferred',
        'Finishing your move to the {{distro}} host: some terminals are still busy.',
        { distro: record.distro }
      )
    }
  }
  if (state.kind !== 'parked') {
    return null
  }
  switch (state.reason) {
    case 'stuck':
      // Never "failed": the projects moved; only an earlier move's settling did not finish.
      return {
        kind: 'stuck',
        text: translate(
          'wslMove.orchestrator.stuck',
          "An earlier move to the {{distro}} host hasn't finished settling.",
          { distro: record.distro }
        )
      }
    case 'declined':
      // A removed host has no row to show this on; re-adding it clears the decline.
      return state.cause === 'removed'
        ? null
        : {
            kind: 'declined',
            text: translate(
              'wslMove.orchestrator.declined',
              'Moving is paused because you brought these projects back to this computer.'
            )
          }
    case 'export-incomplete':
    case 'manifest-too-large':
    case 'host-update-required':
    case 'attempts-exhausted':
      return {
        kind: 'paused',
        text: translate(
          'wslMove.orchestrator.paused',
          'Moving projects to the {{distro}} host is paused: {{reason}}.',
          { distro: record.distro, reason: pausedReason(state.reason) }
        )
      }
    // The host row already explains a pending Remove; Retry would only park again.
    case 'removal-pending':
    case 'not-now':
      return null
  }
}

/** Short and calm: these wait for the user, and nothing was lost. */
function pausedReason(
  reason: 'export-incomplete' | 'manifest-too-large' | 'host-update-required' | 'attempts-exhausted'
): string {
  switch (reason) {
    case 'export-incomplete':
      return translate(
        'wslMove.orchestrator.pausedReason.exportIncomplete',
        "some saved state can't be carried over yet"
      )
    case 'manifest-too-large':
      return translate(
        'wslMove.orchestrator.pausedReason.manifestTooLarge',
        'there is more saved state than one move can carry'
      )
    case 'host-update-required':
      return translate(
        'wslMove.orchestrator.pausedReason.hostUpdate',
        'the host needs an update first'
      )
    case 'attempts-exhausted':
      return translate(
        'wslMove.orchestrator.pausedReason.attemptsExhausted',
        "it didn't complete after several tries"
      )
  }
}

/** The toast for a live change to parked; only the states the status line explains get one. */
export function wslMoveOrchestratorParkedToast(record: WslMoveOrchestratorRecord): string | null {
  const line = wslMoveOrchestratorLine(record)
  return line && line.kind !== 'deferred' ? line.text : null
}
