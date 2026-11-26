import type { AppState } from '@/store/types'
import type {
  AgentSenderPublication,
  AgentSenderRevision
} from '../../../../../shared/orchestration/mailbox/agent-sender-associations'

export type AgentSenderPublications = Record<string, Record<string, AgentSenderPublication>>
type State = Partial<Pick<AppState, 'agentSenderPublicationsByHost'>>
const EMPTY: AgentSenderPublications = Object.freeze({})

/** The newest revision accepted for a stored publication whose content it did not change. Each
 *  stored scope is its own object (see `stored`), so this is per host and scope even when a
 *  host hands one object to several scopes. */
const deliveredRevisions = new WeakMap<AgentSenderPublication, AgentSenderRevision>()
const stored = (publication: AgentSenderPublication): AgentSenderPublication => ({
  ...publication
})

/** The newest revision delivered for this stored publication: what the window has applied. */
export function deliveredAgentSenderRevision(
  publication: AgentSenderPublication
): AgentSenderRevision {
  return deliveredRevisions.get(publication) ?? publication.revision
}

/** Field by field, as the index reads them; the revision stamp never counts. */
function sameContent(a: AgentSenderPublication, b: AgentSenderPublication): boolean {
  return (
    a.peerFingerprint === b.peerFingerprint &&
    a.associations.length === b.associations.length &&
    a.attachments.length === b.attachments.length &&
    JSON.stringify(a.principals) === JSON.stringify(b.principals) &&
    JSON.stringify(a.associations) === JSON.stringify(b.associations) &&
    JSON.stringify(a.attachments) === JSON.stringify(b.attachments)
  )
}

/** A host publishes once any frame carries the field; a frame without it changes only its own
 *  scope when it removes that worktree, so capability never follows which scopes have rows.
 *  Deliveries are applied by revision alone: the whole-host publication is the baseline, a scope
 *  newer than both it and that scope's own last delivery overrides that worktree, and nothing
 *  older or equal changes anything, whichever transport, frame or key order delivered it.
 *  A newer delivery with the stored content advances only the delivered revision, so derived
 *  sender data keeps its identity. */
export function agentSenderPublicationPatch(
  state: State,
  host: string,
  scope: string,
  publication: AgentSenderPublication | undefined,
  removed = false
): Partial<State> {
  const source = state.agentSenderPublicationsByHost ?? EMPTY
  const scopes = source[host]
  const set = (next: Record<string, AgentSenderPublication>) => ({
    agentSenderPublicationsByHost: { ...source, [host]: next }
  })
  if (!publication) {
    // The whole-host result is the only statement that a host does not publish.
    if (scope === '*' && scopes) {
      const next = { ...source }
      delete next[host]
      return { agentSenderPublicationsByHost: next }
    }
    // A chat inventory's removal can't speak for terminals: only that scope's override goes.
    if (!removed || !scopes?.[scope]) {
      return {}
    }
    const next = { ...scopes }
    delete next[scope]
    return set(next)
  }
  const { revision } = publication
  const delivered = (current: AgentSenderPublication | undefined) =>
    current && deliveredAgentSenderRevision(current)
  const newerOrEqual = (current: AgentSenderRevision | undefined) =>
    current?.epoch === revision.epoch && current.revision >= revision.revision
  if (newerOrEqual(delivered(scopes?.['*']))) {
    return {}
  }
  const unchanged = (current: AgentSenderPublication) => {
    deliveredRevisions.set(current, revision)
    return {}
  }
  if (scope === '*') {
    const later = (value: AgentSenderPublication) => {
      const applied = deliveredAgentSenderRevision(value)
      return applied.epoch === revision.epoch && applied.revision > revision.revision
    }
    const entries = Object.entries(scopes ?? {}).filter(([id]) => id !== '*')
    const newer = entries.filter(([, value]) => later(value))
    const whole = scopes?.['*']
    // Every scope stays, and the baseline reads the same: nothing derived from it moves.
    if (whole && newer.length === entries.length && sameContent(whole, publication)) {
      return unchanged(whole)
    }
    return set({ ...Object.fromEntries(newer), '*': stored(publication) })
  }
  const current = scopes?.[scope]
  if (newerOrEqual(delivered(current))) {
    return {}
  }
  return current && sameContent(current, publication)
    ? unchanged(current)
    : set({ ...scopes, [scope]: stored(publication) })
}
