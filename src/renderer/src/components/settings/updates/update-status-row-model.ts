import type { UpdateStatus } from '../../../../../shared/updater/update-status-types'
import { isDelayedUpdatePending } from '../../../../../shared/updater/update-delay'

export type UpdateStatusLine =
  | { kind: 'none' }
  | { kind: 'checking' }
  | { kind: 'up-to-date' }
  | { kind: 'held'; version: string; availableAt: number }
  | { kind: 'held-ready'; version: string }
  | { kind: 'unsupported-system' }
  | { kind: 'available'; version: string }
  | { kind: 'downloading'; version: string; percent: number }
  | { kind: 'ready'; version: string }
  | { kind: 'installing'; version: string }
  | { kind: 'install-on-quit' }
  | { kind: 'install-blocked' }
  | { kind: 'failed'; phase: 'check' | 'update' }

export type UpdateStatusActionKind =
  | 'check'
  | 'skip-delay'
  | 'download'
  | 'progress'
  | 'restart'
  | 'retry-install'
  | 'retry-check'
  | 'quit'
  | 'none'

export type UpdateStatusAction = { kind: UpdateStatusActionKind; busy: boolean; disabled: boolean }

/** Text kept behind "Show details" so the status line stays one short line. */
export type UpdateStatusDetails =
  | 'message'
  | 'install-block'
  | 'unsupported-system'
  | 'externally-managed'
  | null

export type UpdateStatusRowModel = {
  line: UpdateStatusLine
  action: UpdateStatusAction
  details: UpdateStatusDetails
  /** Version whose release notes the line links to; null hides the link. */
  notesVersion: string | null
  /** A quiet Check beside a primary that isn't Check, so modifier-click release checks stay reachable. */
  secondaryCheck: { disabled: boolean } | null
}

export type UpdateStatusRowContext = {
  /** macOS staged the update for a normal quit and a restart can't install it now. */
  showManualRestart: boolean
  /** Last known target, for hosts that omit the version on errors. */
  retainedVersion: string | null
  /** False when the team owns the delay, so it can't be skipped. */
  canSkipDelay: boolean
  now: number
}

const act = (kind: UpdateStatusActionKind, busy = false, disabled = busy): UpdateStatusAction => ({
  kind,
  busy,
  disabled
})

function notesFor(status: UpdateStatus, version: string): string | null {
  return status.source === 'local' ? null : version
}

const SECONDARY_CHECK_PRIMARIES = new Set<UpdateStatusActionKind>([
  'skip-delay',
  'download',
  'restart',
  'retry-install',
  'quit'
])

/** One status line and one primary action per updater state; the About status row renders exactly this. */
export function getUpdateStatusRowModel(
  status: UpdateStatus,
  ctx: UpdateStatusRowContext
): UpdateStatusRowModel {
  const primary = getPrimaryModel(status, ctx)
  const showSecondary = SECONDARY_CHECK_PRIMARIES.has(primary.action.kind) && !primary.action.busy
  return {
    ...primary,
    secondaryCheck: showSecondary
      ? {
          // A stuck macOS staging can't be fixed by another check.
          disabled: status.state === 'error' && status.messageCode === 'macStagingTimeout'
        }
      : null
  }
}

function getPrimaryModel(
  status: UpdateStatus,
  ctx: UpdateStatusRowContext
): Omit<UpdateStatusRowModel, 'secondaryCheck'> {
  if (ctx.showManualRestart) {
    return {
      line: { kind: 'install-on-quit' },
      action: act('quit'),
      details: null,
      notesVersion: null
    }
  }
  switch (status.state) {
    case 'idle':
      return { line: { kind: 'none' }, action: act('check'), details: null, notesVersion: null }
    case 'checking':
      return {
        line: { kind: 'checking' },
        action: act('check', true),
        details: null,
        notesVersion: null
      }
    case 'not-available': {
      if (status.unsupportedSystemUpdate) {
        return {
          line: { kind: 'unsupported-system' },
          action: act('check'),
          details: 'unsupported-system',
          notesVersion: null
        }
      }
      const held = status.delayedUpdate
      if (held && isDelayedUpdatePending(held, ctx.now)) {
        return {
          line: { kind: 'held', version: held.version, availableAt: Date.parse(held.availableAt) },
          action: act(ctx.canSkipDelay ? 'skip-delay' : 'check'),
          details: null,
          notesVersion: notesFor(status, held.version)
        }
      }
      if (held) {
        return {
          line: { kind: 'held-ready', version: held.version },
          action: act('check'),
          details: null,
          notesVersion: notesFor(status, held.version)
        }
      }
      return {
        line: { kind: 'up-to-date' },
        action: act('check'),
        details: null,
        notesVersion: null
      }
    }
    case 'available':
      return {
        line: { kind: 'available', version: status.version },
        // A package manager owns this install, so the only useful action is another check.
        action: act(status.externallyManaged ? 'check' : 'download'),
        details: status.externallyManaged ? 'externally-managed' : null,
        notesVersion: notesFor(status, status.version)
      }
    case 'downloading':
      return {
        line: { kind: 'downloading', version: status.version, percent: status.percent },
        action: act('progress'),
        details: null,
        notesVersion: null
      }
    case 'downloaded':
      if (status.installing) {
        return {
          line: { kind: 'installing', version: status.version },
          // Automatic installs restart on their own; a manual one keeps its pressed Restart.
          action: status.automaticDownload ? act('none') : act('restart', true),
          details: null,
          notesVersion: null
        }
      }
      return {
        line: { kind: 'ready', version: status.version },
        action: act('restart'),
        details: null,
        notesVersion: notesFor(status, status.version)
      }
    case 'error': {
      const canRetryInstall = status.retryAction === 'install' && status.retryable !== false
      // A stuck macOS staging can't be fixed by another check; the button stays visible but off.
      const action = canRetryInstall
        ? act('retry-install')
        : act('retry-check', false, status.messageCode === 'macStagingTimeout')
      if (status.installBlock) {
        return {
          line: { kind: 'install-blocked' },
          action,
          details: 'install-block',
          notesVersion: null
        }
      }
      const known = status.version ?? ctx.retainedVersion
      return {
        line: { kind: 'failed', phase: known ? 'update' : 'check' },
        action,
        details: 'message',
        notesVersion: null
      }
    }
  }
}
