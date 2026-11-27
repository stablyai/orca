/** Where a sender a card saved runs now: derived display data, never a structured-worker
 *  credential pane. */
export type AgentSenderAssociation = {
  /** The terminal handle, `dispatch:<id>` or `orca_session_id:<id>` a saved sender carries. */
  identity: string
  paneKey: string
  worktreeId: string
  sessionId?: string
  /** The addressed Dispatch still has its own proved live invocation. Transient display only. */
  dispatchActor?: true
}
/** Which host publication a delivery was cut from: the publishing runtime's epoch and the content
 *  revision the whole host, or one worktree's scope, last changed at. In memory only. */
export type AgentSenderRevision = { epoch: string; revision: number }
export type AgentSenderPublication = {
  associations: readonly AgentSenderAssociation[]
  peerFingerprint?: string
  /** This host's principal as each paired execution peer authenticates it; one per peer. */
  principals: readonly { peerFingerprint: string; homePeerFingerprint: string }[]
  attachments: readonly (AgentSenderAssociation & { homePeerFingerprint: string })[]
  /** Every publishing host stamps one; hosts that predate publications send no field at all. */
  revision: AgentSenderRevision
}

type AgentSenderContent = Omit<AgentSenderPublication, 'revision'>
type Attachment = AgentSenderPublication['attachments'][number]
type Principal = AgentSenderPublication['principals'][number]

// A field added to a publication or its rows fails compilation here until the comparison reads it.
type ComparedField =
  | 'peerFingerprint'
  | 'principals'
  | 'associations'
  | 'attachments'
  | 'identity'
  | 'paneKey'
  | 'worktreeId'
  | 'sessionId'
  | 'dispatchActor'
  | 'homePeerFingerprint'
type UncomparedField = Exclude<
  keyof AgentSenderContent | keyof Attachment | keyof Principal,
  ComparedField
>
const everyFieldCompared: [UncomparedField] extends [never] ? true : UncomparedField = true
void everyFieldCompared

const sameAssociation = (a: AgentSenderAssociation, b: AgentSenderAssociation) =>
  a.identity === b.identity &&
  a.paneKey === b.paneKey &&
  a.worktreeId === b.worktreeId &&
  a.sessionId === b.sessionId &&
  a.dispatchActor === b.dispatchActor
const sameAttachment = (a: Attachment, b: Attachment) =>
  a.homePeerFingerprint === b.homePeerFingerprint && sameAssociation(a, b)
const samePrincipal = (a: Principal, b: Principal) =>
  a.peerFingerprint === b.peerFingerprint && a.homePeerFingerprint === b.homePeerFingerprint

function sameRows<T>(a: readonly T[], b: readonly T[], same: (a: T, b: T) => boolean): boolean {
  if (a === b) {
    return true
  }
  if (a.length !== b.length) {
    return false
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i] && !same(a[i], b[i])) {
      return false
    }
  }
  return true
}

/** Field by field, in row order, as clients read them; key order and the revision never count. */
export function sameAgentSenderContent(a: AgentSenderContent, b: AgentSenderContent): boolean {
  return (
    a === b ||
    (a.peerFingerprint === b.peerFingerprint &&
      sameRows(a.principals, b.principals, samePrincipal) &&
      sameRows(a.associations, b.associations, sameAssociation) &&
      sameRows(a.attachments, b.attachments, sameAttachment))
  )
}
