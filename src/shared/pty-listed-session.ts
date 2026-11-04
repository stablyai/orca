/** Missing owners prove absence only when providesAgentSessionOwnerListings is true. Legacy daemon/SSH or in-process
 * providers cannot serialize claims, so their empty listings remain unknown even if sessions have owners. */
export type AgentOwnershipEvidence = 'present' | 'absent' | 'unknown'

/** Omission lists established routes; explicit null selects local, with raw candidates opt-in. */
export type PtySessionListScope = { connectionId: string | null; includeUnrouted?: boolean }

export function ptySessionIdentity(session: {
  id: string
  incarnationId?: string
  inventorySourceId?: string
}): string {
  const identity = [session.id, session.incarnationId ?? null]
  if (session.inventorySourceId !== undefined) {
    identity.push(session.inventorySourceId)
  }
  return JSON.stringify(identity)
}

/** Share pty:listSessions evidence across main, preloads and renderer so UI authority cannot drift. */
export type PtyListedSession = {
  id: string
  incarnationId?: string
  /** Local diagnostic provenance, distinct even when legacy hosts omit incarnations. */
  inventorySourceId?: string
  /** Whether this candidate is the established route for its id; absent on older publishers. */
  routed?: boolean
  fencedTermination?: boolean
  rootProcessId?: number
  /** Recently observed process name; inventory reads never initiate process inspection. */
  foregroundProcess?: string
  cwd: string
  title: string
  worktreeId?: string
  /** Pane key the PTY was spawned with; reattaching from another pane never changes it. */
  paneKey?: string
  /** Destructive actions treat unknown as live work; only proven absent is safe (#8459’s live-session force kills). */
  agentOwnership: AgentOwnershipEvidence
  /** Still live, but its host is terminating it after an accepted kill: never adopt or restore it. */
  exiting?: true
}

/** Only proven absence authorizes destroying a session without asking. */
export function mayDestroyWithoutOwnerEvidence(session: {
  agentOwnership: AgentOwnershipEvidence
}): boolean {
  return session.agentOwnership === 'absent'
}

export type PtySessionLifecycle = { id: string; incarnationId?: string; hostId?: string }
