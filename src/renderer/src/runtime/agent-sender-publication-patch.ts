import type { AppState } from '@/store/types'
import type {
  AgentSenderPublication,
  AgentSenderRevision
} from '../../../shared/agent-sender-associations'

export type AgentSenderPublications = Record<string, Record<string, AgentSenderPublication>>
type State = Partial<Pick<AppState, 'agentSenderPublicationsByHost'>>
const EMPTY: AgentSenderPublications = Object.freeze({})

const sameRevision = (a?: AgentSenderRevision, b?: AgentSenderRevision) =>
  Boolean(a && b && a.epoch === b.epoch && a.revision === b.revision)

/** A host publishes once any frame carries the field; a frame without it changes only its own
 *  scope when it removes that worktree, so capability never follows which scopes have rows.
 *  Revisioned deliveries are applied by revision alone: the whole-host publication is the
 *  baseline, a scope newer than it overrides that worktree, and nothing older or equal changes
 *  anything, whichever transport or key order delivered it. */
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
  const revision = publication.revision
  const whole = scopes?.['*']
  if (revision) {
    const baseline = whole?.revision?.epoch === revision.epoch ? whole.revision.revision : -1
    if (scope === '*') {
      if (baseline >= revision.revision) {
        return {}
      }
      const newer = Object.entries(scopes ?? {}).filter(
        ([id, value]) =>
          id !== '*' &&
          value.revision?.epoch === revision.epoch &&
          value.revision.revision > revision.revision
      )
      return set({ ...Object.fromEntries(newer), '*': publication })
    }
    if (baseline >= revision.revision || sameRevision(scopes?.[scope]?.revision, revision)) {
      return {}
    }
    return set({ ...scopes, [scope]: publication })
  }
  // A host before revisions sends complete publications, compared by content.
  if (scope !== '*' && whole) {
    const current = {
      ...whole,
      associations: whole.associations.filter((row) => row.worktreeId === scope),
      attachments: whole.attachments.filter((row) => row.worktreeId === scope)
    }
    if (JSON.stringify(current) === JSON.stringify(publication)) {
      return {}
    }
    publication = {
      ...publication,
      associations: [
        ...whole.associations.filter((row) => row.worktreeId !== scope),
        ...publication.associations
      ],
      attachments: [
        ...whole.attachments.filter((row) => row.worktreeId !== scope),
        ...publication.attachments
      ]
    }
    scope = '*'
  }
  if (JSON.stringify(scopes?.[scope]) === JSON.stringify(publication)) {
    return {}
  }
  return set({ ...scopes, [scope]: publication })
}

/** What a host publishes now: its whole-host baseline, with each newer scope in its worktree. */
export function effectivePublications(
  scopes: Record<string, AgentSenderPublication>
): AgentSenderPublication[] {
  const whole = scopes['*']
  const parts = Object.entries(scopes).flatMap(([id, value]) => (id === '*' ? [] : [value]))
  if (!whole || parts.length === 0) {
    return whole ? [whole] : parts
  }
  const overridden = new Set(Object.keys(scopes))
  return [
    {
      ...whole,
      associations: whole.associations.filter((row) => !overridden.has(row.worktreeId)),
      attachments: whole.attachments.filter((row) => !overridden.has(row.worktreeId))
    },
    ...parts
  ]
}
