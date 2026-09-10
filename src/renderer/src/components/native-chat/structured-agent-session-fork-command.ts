import {
  createStructuredAgentSessionId,
  structuredAgentSessionCreateParams,
  type StructuredAgentSessionCreateParams
} from '../../../../shared/structured-agent-session-create'
import type { AgentSessionForkSource } from '../../../../shared/agent-session-fork'
import type {
  AgentSessionAttachResult,
  AgentSessionMutationResult,
  AgentSessionWireRefusal
} from '../../../../shared/agent-session-wire'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import {
  callStructuredAgentSession,
  StructuredAgentSessionCapabilityError
} from '@/runtime/structured-agent-session-client'
import { translate } from '@/i18n/i18n'

type ForkAttempt = {
  params: StructuredAgentSessionCreateParams
  running?: Promise<string>
  /** The last outcome left this child's fate unknown, so its ids are the only way to adjudicate it. */
  unconfirmed?: boolean
}

const attempts = new Map<string, ForkAttempt>()
const MAX_TRACKED_ATTEMPTS = 128

/** Resolves with the CHILD session id so the caller can offer a way into it; a fork publishes its
 *  tab without activating it. */
export function forkStructuredSessionFromTurn(input: {
  target: RuntimeClientTarget
  worktree: string
  agent: 'claude' | 'codex'
  source: AgentSessionForkSource
}): Promise<string> {
  const key = JSON.stringify([
    input.target.kind === 'local' ? 'local' : input.target.environmentId,
    input.worktree,
    input.agent,
    input.source.sessionId,
    input.source.itemId,
    input.source.expectedEpoch,
    input.source.expectedRuntimeFence
  ])
  let attempt = attempts.get(key)
  if (attempt?.running) {
    return attempt.running
  }
  if (attempt) {
    // Re-insert: the map's insertion order IS the eviction order, so reuse has to refresh recency
    // or the turn a user keeps retrying is evicted before one they touched once and abandoned.
    attempts.delete(key)
    attempts.set(key, attempt)
  } else {
    attempt = {
      params: structuredAgentSessionCreateParams({
        sessionId: createStructuredAgentSessionId(input.agent, () => crypto.randomUUID()),
        worktree: input.worktree,
        agent: input.agent,
        forkFrom: input.source,
        randomUuid: () => crypto.randomUUID()
      })
    }
    track(key, attempt)
  }
  const current = attempt
  current.running = callStructuredAgentSession<
    AgentSessionMutationResult<AgentSessionAttachResult>
  >(input.target, 'agentSession.create', current.params)
    .then(
      (result) => {
        if (!result.ok) {
          throw refusalError(current, key, result.refusal)
        }
        attempts.delete(key)
        return result.value.sessionId
      },
      (error: unknown) => {
        // The capability guard runs before the request leaves the client, so no child exists: the
        // attempt is retired and the real reason reaches the user.
        if (error instanceof StructuredAgentSessionCapabilityError) {
          attempts.delete(key)
          throw error
        }
        current.unconfirmed = true
        throw new Error(unconfirmed())
      }
    )
    .finally(() => {
      current.running = undefined
    })
  return current.running
}

/** Bound the table by EVICTING the least recently used entry with nothing left to adjudicate.
 *  Refusing at the cap instead wedged forking app-wide — every session, tab and worktree — until a
 *  restart, reported as an unconfirmed fork.
 *
 *  An UNCONFIRMED entry is idle but is retained precisely so a retry can adjudicate the child that
 *  may already exist, so it is evicted only once nothing else can be: dropping it makes the next
 *  fork of that turn mint a SECOND provider session, the one thing this ledger exists to prevent. */
function track(key: string, attempt: ForkAttempt): void {
  while (attempts.size >= MAX_TRACKED_ATTEMPTS) {
    if (
      !evictOldest((entry) => !entry.running && !entry.unconfirmed) &&
      !evictOldest((entry) => !entry.running)
    ) {
      break
    }
  }
  attempts.set(key, attempt)
}

function evictOldest(admissible: (entry: ForkAttempt) => boolean): boolean {
  for (const [candidate, entry] of attempts) {
    if (admissible(entry)) {
      attempts.delete(candidate)
      return true
    }
  }
  return false
}

/** A settled refusal proves the host minted no provider session, so the child id is retired and a
 *  retry starts clean. An unknown or mismatched outcome must reuse it to adjudicate the original. */
function refusalError(attempt: ForkAttempt, key: string, refusal: AgentSessionWireRefusal): Error {
  const reason = refusal.forkReason
  if (reason === undefined) {
    // No `forkReason` means the host refused somewhere with no fork vocabulary at all — a provider
    // that never finished starting, a stale checkpoint, an unsupported workspace. Every refusal
    // carries a `code` and a `message`; reporting them all as "could not be confirmed" threw away
    // the only diagnostic anyone had. The attempt is still RETAINED, because a refusal raised after
    // acquisition began may have left a child behind.
    attempt.unconfirmed = true
    return new Error(
      translate('components.native-chat.forkRefused', 'Could not fork this turn: {{reason}}', {
        reason: refusal.message
      })
    )
  }
  if (reason === 'outcome-unknown' || reason === 'proof-mismatch') {
    attempt.unconfirmed = true
    return new Error(unconfirmed())
  }
  attempts.delete(key)
  return new Error(refusalMessage(reason))
}

function refusalMessage(reason: string): string {
  switch (reason) {
    case 'busy':
      return translate(
        'components.native-chat.forkBusy',
        'Wait for this conversation to finish, then fork the turn.'
      )
    case 'unsupported':
    case 'history-not-paginated':
      return translate(
        'components.native-chat.forkUnsupported',
        'This conversation cannot be forked.'
      )
    case 'history-limit':
      return translate(
        'components.native-chat.forkHistoryLimit',
        'This turn carries too much history to fork.'
      )
    case 'stale-epoch':
      return translate(
        'components.native-chat.forkStaleEpoch',
        'This conversation moved on. Reopen it and fork the turn again.'
      )
    default:
      return translate('components.native-chat.forkFailed', 'Could not fork this turn.')
  }
}

function unconfirmed(): string {
  return translate(
    'components.native-chat.forkUnconfirmed',
    'A fork could not be confirmed. Retry the same turn to check its outcome.'
  )
}
