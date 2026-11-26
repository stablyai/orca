import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import type { LinkPreferenceFields } from './link-preference-publication'
import { dismissLinkPreferenceNotice, showLinkPreferenceNotice } from './link-preference-notice'

export type LinkPreferenceSource = 'remember' | 'settings'
export type LinkAdmissionOutcome = 'admitted' | 'refused' | 'failed' | 'superseded'

/** One user choice, carried unchanged from selection through admission, write and notice. */
export type LinkPreferenceOperation = {
  readonly id: number
  readonly source: LinkPreferenceSource
  readonly requested: LinkPreferenceFields
  phase: 'selected' | 'issued' | 'settled' | 'ended'
}

export type LinkPreferenceWriter = {
  updateSettingsOrThrow: (
    updates: LinkPreferenceFields,
    onAcknowledged: (accepted: GlobalSettings) => void
  ) => Promise<void>
  /** One settings read applied on arrival; resolves to the window's link fields, or null when unreadable. */
  reconcile: () => Promise<LinkPreferenceFields | null>
}

let latestId = 0
const notIssued = new Set<LinkPreferenceOperation>()
let visible: { opId: number; requested: LinkPreferenceFields } | null = null

const LINK_KEYS = [
  'openLinksInApp',
  'httpLinkClickBehavior',
  'openLinksInAppPreferencePrompted'
] as const

function matches(fields: LinkPreferenceFields, requested: LinkPreferenceFields): boolean {
  return LINK_KEYS.every((key) => !(key in requested) || fields[key] === requested[key])
}

function dismissVisible(): void {
  if (visible) {
    visible = null
    dismissLinkPreferenceNotice()
  }
}

function end(op: LinkPreferenceOperation): void {
  notIssued.delete(op)
  op.phase = 'ended'
}

function isCurrent(op: LinkPreferenceOperation): boolean {
  return op.id === latestId
}

function notify(op: LinkPreferenceOperation, kind: 'saved' | 'failed' | 'unknown'): void {
  if (op.source !== 'remember' || !isCurrent(op)) {
    return
  }
  if (kind === 'saved') {
    visible = { opId: op.id, requested: op.requested }
    showLinkPreferenceNotice({ kind, openLinksInApp: op.requested.openLinksInApp === true })
    return
  }
  visible = null
  showLinkPreferenceNotice({ kind })
}

/** A newer choice in this window supersedes every earlier one (E1). */
export function beginLinkPreferenceOperation(
  source: LinkPreferenceSource,
  requested: LinkPreferenceFields
): LinkPreferenceOperation {
  for (const earlier of notIssued) {
    end(earlier)
  }
  dismissVisible()
  const op: LinkPreferenceOperation = { id: ++latestId, source, requested, phase: 'selected' }
  notIssued.add(op)
  return op
}

/** Another window or main accepted a different link choice; a choice not yet written yields to it (E2). */
export function noteIncomingLinkPatch(
  patch: Readonly<Record<string, unknown>>,
  before: Partial<GlobalSettings> | null
): void {
  // Any link field counts: re-picking Ask in another window changes only the prompted flag on upgraded profiles.
  const changed = LINK_KEYS.some((key) => key in patch && patch[key] !== before?.[key])
  if (!changed) {
    return
  }
  for (const op of notIssued) {
    end(op)
  }
}

/** Link fields moved away from what a visible notice announced (E3). */
export function noteLinkFieldsArrived(current: LinkPreferenceFields): void {
  if (visible && !matches(current, visible.requested)) {
    dismissVisible()
  }
}

/** Remember writes only after the open was admitted, and only while it is still the newest choice (E4). */
export function admitLinkPreferenceOperation(
  op: LinkPreferenceOperation,
  outcome: LinkAdmissionOutcome
): boolean {
  if (op.phase !== 'selected') {
    return false
  }
  if (outcome !== 'admitted' || !isCurrent(op)) {
    end(op)
    return false
  }
  return true
}

/** Never rejects: an unreadable outcome becomes the unknown notice, not an error the opener sees. */
export async function writeLinkPreference(
  op: LinkPreferenceOperation,
  writer: LinkPreferenceWriter
): Promise<void> {
  if (op.phase !== 'selected') {
    return
  }
  notIssued.delete(op)
  op.phase = 'issued'
  try {
    await writer.updateSettingsOrThrow(op.requested, (accepted) => {
      op.phase = 'settled'
      // A later accepted change already in this reply means the choice did not stick.
      if (matches(accepted, op.requested)) {
        notify(op, 'saved')
      }
    })
    return
  } catch {
    // A rejected reply does not prove main refused the write; one read decides.
  }
  let reconciled: LinkPreferenceFields | null
  try {
    reconciled = await writer.reconcile()
  } catch {
    reconciled = null
  }
  op.phase = 'settled'
  if (reconciled === null) {
    notify(op, 'unknown')
  } else if (matches(reconciled, op.requested)) {
    notify(op, 'saved')
  } else {
    notify(op, 'failed')
  }
}
