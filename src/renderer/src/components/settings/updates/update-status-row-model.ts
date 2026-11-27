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

type UpdateStatusActionKind = 'check' | 'skip-delay' | 'download'

type UpdateStatusAction = { kind: UpdateStatusActionKind; busy: boolean }

/** Text kept behind "Show details" so the status line stays one short line. */
type UpdateStatusDetails = 'unsupported-system' | 'externally-managed' | null

export type UpdateStatusRowModel = {
  line: UpdateStatusLine
  action: UpdateStatusAction
  details: UpdateStatusDetails
  /** Version whose release notes the line links to; null hides the link. */
  notesVersion: string | null
  /** A quiet Check beside a primary that isn't Check, so modifier-click release checks stay reachable. */
  secondaryCheck: boolean
}

export type UpdateStatusRowContext = {
  /** False when the team owns the delay, so it can't be skipped. */
  canSkipDelay: boolean
  now: number
}

const act = (kind: UpdateStatusActionKind, busy = false): UpdateStatusAction => ({
  kind,
  busy
})

function notesFor(status: UpdateStatus, version: string): string | null {
  return status.source === 'local' ? null : version
}

/** About offers the check and download actions. The app-wide card handles progress and recovery. */
export function getUpdateStatusRowModel(
  status: UpdateStatus,
  ctx: UpdateStatusRowContext
): UpdateStatusRowModel | null {
  const primary = getPrimaryModel(status, ctx)
  return primary && { ...primary, secondaryCheck: primary.action.kind !== 'check' }
}

function getPrimaryModel(
  status: UpdateStatus,
  ctx: UpdateStatusRowContext
): Omit<UpdateStatusRowModel, 'secondaryCheck'> | null {
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
    case 'downloaded':
    case 'error':
      return null
  }
}
