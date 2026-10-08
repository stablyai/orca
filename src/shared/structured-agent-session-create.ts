import type { StructuredAgentId } from './agent-session-provider-handle'
import type { AgentSessionMutationEnvelope } from './agent-session-wire'
import {
  createStructuredAgentSessionOperationId,
  structuredAgentSessionCreateFingerprint
} from './structured-agent-session-mutation'

/**
 * The conversation a create adopts instead of starting a fresh one.
 *
 * Deliberately carries an identity and nothing else. The transcript file and the account home it
 * lives under are derived by the executing host, never sent: `agentSession.create` is reachable by
 * paired mobile clients, and a client-supplied path would let one choose which file the host reads
 * into a journal and which credential directory the provider child launches against.
 */
export type StructuredAgentSessionResumeSource = {
  /** claude: the session id. codex: the thread id. */
  providerSessionId: string
}

/**
 * The turn a create forks instead of starting fresh: a chat on the same host, and a row of the turn
 * to copy it through. Like `resumeFrom`, an identity only; the host works out what to copy.
 */
export type StructuredAgentSessionForkSource = {
  sessionId: string
  itemId: string
}

/** The conversation a create continues instead of starting one: at most one of the two. */
export type StructuredAgentSessionCreateSource = {
  resumeFrom?: StructuredAgentSessionResumeSource
  /** Sent only to a host advertising `AGENT_SESSION_FORK_RUNTIME_CAPABILITY`. */
  forkFrom?: StructuredAgentSessionForkSource
}

/** Just the source of `from`, so a caller carrying it onward never spreads an absent field. */
export function structuredAgentSessionCreateSource(
  from: StructuredAgentSessionCreateSource
): StructuredAgentSessionCreateSource {
  return {
    ...(from.resumeFrom ? { resumeFrom: from.resumeFrom } : {}),
    ...(from.forkFrom ? { forkFrom: from.forkFrom } : {})
  }
}

/** Whether a create continues a conversation that already exists, by resuming or forking it. */
export function structuredAgentSessionCreateContinues(
  from: StructuredAgentSessionCreateSource
): boolean {
  return from.resumeFrom !== undefined || from.forkFrom !== undefined
}

export type StructuredAgentSessionCreateParams = StructuredAgentSessionCreateSource & {
  envelope: AgentSessionMutationEnvelope
  worktree: string
  agent: StructuredAgentId
  /** Sent only to a host advertising `AGENT_SESSION_CREATE_TAB_ID_RUNTIME_CAPABILITY`. */
  tabId?: string
}

/** Provider-prefixed so a session id names its lane on sight, and underscore-only
 *  so the id stays a single token everywhere it is embedded (tab ids, log keys). */
export function createStructuredAgentSessionId(
  agent: StructuredAgentId,
  randomUuid: () => string
): string {
  return `${agent}_${randomUuid().replaceAll('-', '_')}`
}

/** Whether a caller-minted id keeps the shape `createStructuredAgentSessionId` gives every id:
 *  named for its agent, then one token. The token alone is checked, so a hyphenated agent name
 *  is not refused at the wire. */
export function isStructuredAgentSessionIdFor(agent: string, sessionId: string): boolean {
  const prefix = `${agent}_`
  return sessionId.startsWith(prefix) && /^[A-Za-z0-9_]+$/.test(sessionId.slice(prefix.length))
}

/**
 * The durable `agentSession.create` envelope every client replays on an ambiguous
 * transport failure. The fingerprint must be computed over the same fields the host
 * recomputes, so both clients build it here rather than each assembling their own.
 */
export function structuredAgentSessionCreateParams(
  args: StructuredAgentSessionCreateSource & {
    sessionId: string
    worktree: string
    agent: StructuredAgentId
    tabId?: string
    randomUuid: () => string
    now?: number
  }
): StructuredAgentSessionCreateParams {
  const fields = {
    worktree: args.worktree,
    agent: args.agent,
    ...structuredAgentSessionCreateSource(args),
    ...(args.tabId ? { tabId: args.tabId } : {})
  }
  return {
    envelope: {
      sessionId: args.sessionId,
      clientOperationId: createStructuredAgentSessionOperationId(args.randomUuid, args.now),
      expectedRuntimeFence: null,
      payloadFingerprint: structuredAgentSessionCreateFingerprint({
        sessionId: args.sessionId,
        ...fields
      })
    },
    ...fields
  }
}
