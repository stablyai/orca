/** Plain-language copy for the WSL move dialog: no "manifest", "orcad" or "UNC". */
import { translate } from '@/i18n/i18n'
import type {
  WslMoveBlockerKind,
  WslMoveProgressStep,
  WslMoveRefusal
} from '../../../../shared/wsl-move/wsl-move-driver-types'

/** Decision C, verbatim from the design. */
export function wslMoveChatsStayCopy(): string {
  return translate(
    'wslMove.preview.chatsStay',
    'Existing chats stay on this computer. New chats in this project start on the WSL host.'
  )
}

/** The preview's note when the host's browser would start signed out; the move still goes ahead. */
export function wslMoveBrowserLoginsNotCarried(reason: string): string {
  return reason === 'destination-partition-conflict'
    ? translate(
        'wslMove.preview.browserLoginsConflict',
        'Browser sign-ins won’t carry over, because the host’s browser profile is already in use. Sign in again in the host’s browser tabs after the move.'
      )
    : translate(
        'wslMove.preview.browserLoginsNotCarried',
        'Browser sign-ins won’t carry over to this host. Sign in again in its browser tabs after the move.'
      )
}

export function wslMoveRefusalMessage(
  refusal: WslMoveRefusal,
  distro: string,
  /** Preview refusals describe what a start would do; results describe what happened. */
  context: 'preview' | 'result' = 'result'
): string {
  switch (refusal.code) {
    case 'wsl_move_unavailable':
      if (refusal.detail === 'preview-failed') {
        return translate(
          'wslMove.refusal.previewFailed',
          'Orca could not check these projects. Try again.'
        )
      }
      if (refusal.detail === 'start-failed') {
        return translate(
          'wslMove.refusal.startFailed',
          'Orca lost contact with the move. Open this dialog again to see where it stands.'
        )
      }
      return translate(
        'wslMove.refusal.unavailable',
        'Moving projects to a WSL host is not available in this window.'
      )
    case 'wsl_move_already_running':
      return translate(
        'wslMove.refusal.alreadyRunning',
        'A move into {{distro}} is already running. Wait for it to finish, then try again.',
        { distro }
      )
    case 'wsl_move_undo_running':
      return translate(
        'wslMove.refusal.undoRunning',
        'A project is coming back from {{distro}}. Try again once that finishes.',
        { distro }
      )
    case 'wsl_move_already_in_flight':
      return context === 'preview'
        ? translate(
            'wslMove.refusal.alreadyInFlightPreview',
            'A move of {{distro}} is still finishing. Starting this move first finishes or undoes it where Orca can.',
            { distro }
          )
        : translate(
            'wslMove.refusal.alreadyInFlight',
            'A move of {{distro}} is still finishing, so this one did not start. Keep the {{distro}} host connected and try again later.',
            { distro }
          )
    case 'wsl_move_nothing_new':
      return translate(
        'wslMove.refusal.nothingNew',
        'These projects are already on the {{distro}} host.',
        { distro }
      )
    case 'wsl_move_host_unavailable':
      return refusal.detail === 'destination_changed'
        ? translate(
            'wslMove.refusal.destinationChanged',
            'Earlier projects from {{distro}} moved to a different WSL host. Connect that host to move more.',
            { distro }
          )
        : translate(
            'wslMove.refusal.hostUnavailable',
            'The {{distro}} host is not connected. Connect it in Settings, then try again.',
            { distro }
          )
    case 'wsl_move_host_update_required':
      return translate(
        'wslMove.refusal.hostUpdateRequired',
        'The {{distro}} host runs an older version of Orca. Update it in Settings, then try again.',
        { distro }
      )
    case 'wsl_move_terminals_blocked':
      return translate(
        'wslMove.refusal.terminalsBlocked',
        'Some terminals, agents or automations in these projects are busy. Nothing was moved.'
      )
    case 'wsl_move_export_incomplete':
      if (context === 'preview') {
        return translate(
          'wslMove.refusal.exportIncompletePreview',
          "Some saved state in these projects can't move yet:"
        )
      }
      return translate(
        'wslMove.refusal.exportIncomplete',
        'Some saved state in these projects cannot move yet, so nothing was moved:'
      )
    case 'wsl_move_manifest_too_large':
      return (
        refusal.message ??
        translate(
          'wslMove.refusal.tooLarge',
          'These projects have too much saved state to move in one step. Move fewer projects at a time.'
        )
      )
    case 'wsl_move_pause_failed':
      return translate(
        'wslMove.refusal.pauseFailed',
        'Orca could not pause the terminals in these projects, so nothing was moved. Paused terminals start again when you open them. Try again.'
      )
    case 'wsl_move_scope_changed':
      return translate(
        'wslMove.refusal.scopeChanged',
        'A project changed while the move was getting ready, so nothing was moved. Check the projects and try again.'
      )
    case 'wsl_move_cancelled':
      return translate('wslMove.refusal.cancelled', 'Move cancelled. Nothing was moved.')
    case 'wsl_move_finished_earlier_move':
      return translate(
        'wslMove.refusal.finishedEarlierMove',
        'Orca first finished an earlier move into {{distro}}. Reload the window, then start this move again.',
        { distro }
      )
  }
}

export function wslMoveStepLabel(step: WslMoveProgressStep): string {
  switch (step) {
    case 'preparing':
      return translate('wslMove.step.preparing', 'Preparing')
    case 'pausing-terminals':
      return translate('wslMove.step.pausingTerminals', 'Pausing terminals')
    case 'copying':
      return translate('wslMove.step.copying', 'Copying')
    case 'switching':
      return translate('wslMove.step.switching', 'Switching')
    case 'finishing':
      return translate('wslMove.step.finishing', 'Finishing')
    case 'done':
      return translate('wslMove.step.done', 'Done')
  }
}

export function wslMoveBlockerTitle(kind: WslMoveBlockerKind, n: number): string {
  const one = n === 1
  switch (kind) {
    case 'agent-working':
      return one
        ? translate(
            'wslMove.blocker.agentWorkingOne',
            'An agent is working or waiting for an answer'
          )
        : translate(
            'wslMove.blocker.agentWorkingMany',
            '{{n}} agents are working or waiting for an answer',
            { n }
          )
    case 'process-running':
      return one
        ? translate('wslMove.blocker.processRunningOne', 'A terminal is running a program')
        : translate('wslMove.blocker.processRunningMany', '{{n}} terminals are running a program', {
            n
          })
    case 'agent-not-resumable':
      return one
        ? translate(
            'wslMove.blocker.agentNotResumableOne',
            'An agent cannot be resumed after the move'
          )
        : translate(
            'wslMove.blocker.agentNotResumableMany',
            '{{n}} agents cannot be resumed after the move',
            { n }
          )
    case 'unverifiable':
      return one
        ? translate('wslMove.blocker.unverifiableOne', 'Orca cannot check a terminal right now')
        : translate(
            'wslMove.blocker.unverifiableMany',
            'Orca cannot check {{n}} terminals right now',
            {
              n
            }
          )
    case 'automation-running':
      return one
        ? translate('wslMove.blocker.automationRunningOne', 'An automation run is active')
        : translate('wslMove.blocker.automationRunningMany', '{{n}} automation runs are active', {
            n
          })
    case 'dispatch-running':
      return one
        ? translate('wslMove.blocker.dispatchRunningOne', 'An agent task is in progress')
        : translate('wslMove.blocker.dispatchRunningMany', '{{n}} agent tasks are in progress', {
            n
          })
    case 'scrollback-too-large':
      return one
        ? translate(
            'wslMove.blocker.scrollbackTooLargeOne',
            'A terminal has too much output history to move'
          )
        : translate(
            'wslMove.blocker.scrollbackTooLargeMany',
            '{{n}} terminals have too much output history to move',
            { n }
          )
  }
}

/** What the user can do about a blocker kind, given the actions main offers for it. */
export function wslMoveBlockerHint(kind: WslMoveBlockerKind): string {
  switch (kind) {
    case 'agent-working':
      return translate(
        'wslMove.blockerHint.agentWorking',
        'Let it finish, or stop it in its terminal, then check again.'
      )
    case 'process-running':
      return translate(
        'wslMove.blockerHint.processRunning',
        'Stop the program (for example a dev server or editor), then check again.'
      )
    case 'agent-not-resumable':
      return translate(
        'wslMove.blockerHint.agentNotResumable',
        'Exit the agent in its terminal, then check again.'
      )
    case 'unverifiable':
      return translate(
        'wslMove.blockerHint.unverifiable',
        'Wait a moment, then check again. Nothing is stopped to make the move happen.'
      )
    case 'automation-running':
    case 'dispatch-running':
      return translate('wslMove.blockerHint.wait', 'Wait for it to finish, then check again.')
    case 'scrollback-too-large':
      return translate(
        'wslMove.blockerHint.scrollbackTooLarge',
        'Clear the terminal output in those terminals, then check again.'
      )
  }
}

export function wslMoveScopeRefusalReason(reason: string): string {
  switch (reason) {
    case 'windows-drive':
      return translate(
        'wslMove.scopeRefused.windowsDrive',
        'Its folder is on a Windows drive, so it stays on this computer.'
      )
    case 'mixed-locations':
      return translate(
        'wslMove.scopeRefused.mixedLocations',
        'Some of its folders are outside this distro, so it stays on this computer.'
      )
    case 'not-local':
      return translate('wslMove.scopeRefused.notLocal', 'It already runs on another host.')
    default:
      return translate('wslMove.scopeRefused.other', 'It cannot move.')
  }
}

/** 7f's reasons the host's browser starts signed out; an unknown one reads generically. */
export function wslMoveBrowserLoginsNotCopied(reason: string): string {
  switch (reason) {
    case 'no-stable-partition':
    case 'destination-environment-missing':
      return translate(
        'wslMove.result.browserLoginsHostUnknown',
        'Browser logins were not copied, because Orca could not identify the host’s browser profile. Sign in again in the host’s browser tabs.'
      )
    case 'destination-partition-conflict':
      return translate(
        'wslMove.result.browserLoginsConflict',
        'Browser logins were not copied, because the host’s browser profile is already in use. Sign in again in the host’s browser tabs.'
      )
    default:
      return translate(
        'wslMove.result.browserLoginsNotCopied',
        'Browser logins were not copied to the host. Sign in again in the host’s browser tabs.'
      )
  }
}

export function formatWslMoveBytes(bytes: number): string {
  // A small move read "0.0 MB of 0.0 MB".
  if (bytes < 1024) {
    return `${Math.max(0, Math.round(bytes))} B`
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`
  }
  const megabytes = bytes / (1024 * 1024)
  return megabytes >= 10 ? `${Math.round(megabytes)} MB` : `${megabytes.toFixed(1)} MB`
}
