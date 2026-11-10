import {
  AGENT_SESSION_CREATE_FORK_RUNTIME_CAPABILITY,
  AGENT_SESSION_CREATE_FORK_ORIGINAL_RUNTIME_CAPABILITY
} from '../../../../../shared/agent-session/agent-session-create-capabilities'
import {
  AGENT_SESSION_AGENTS_METHOD,
  decodeAgentSessionAgentsResult
} from '../../../../../shared/agent-session/agent-session-registered-agents'
import type {
  AgentSessionHistoryPage,
  AgentSessionHistoryResult
} from '../../../../../shared/agent-session/agent-session-wire'
import type { AgentJournalRenderItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { nativeChatForkRequiresInheritedOriginal } from '../../../../../shared/native-chat/native-chat-fork-offer'
import { runtimeEnvironmentCapabilityProof } from '@/runtime/rpc/compatibility/runtime-capability-proof'
import { callStructuredAgentSession } from '@/runtime/native-chat/requests/structured-agent-session-call'
import { structuredAgentSessionHostCapabilityState } from '@/runtime/native-chat/host-capabilities/structured-agent-session-host-support'
import type { StructuredAgentSessionLaunchIntent } from '../../launch-structured-agent-session'
import { abandonStructuredAgentSessionLaunchIntent } from './structured-agent-session-launch-abandon'
import {
  StructuredAgentSessionCreateRefusalError,
  StructuredAgentSessionCreateUnknownOutcomeError
} from './structured-agent-session-launch-errors'

/** The refusal a fork gets from a host that does not advertise forks; nothing was sent to it. */
export const STRUCTURED_LAUNCH_FORK_UNSUPPORTED_REFUSAL =
  'structured_agent_session_fork_unsupported'

export async function requireHostForkSupport(
  intent: StructuredAgentSessionLaunchIntent
): Promise<void> {
  if (!intent.params.forkFrom) {
    return
  }
  const support = await structuredAgentSessionHostCapabilityState(
    intent.target,
    AGENT_SESSION_CREATE_FORK_RUNTIME_CAPABILITY
  )
  if (support === 'supported') {
    return
  }
  // An unanswered probe may follow a create whose reply was lost, so it settles nothing.
  if (support === 'unknown') {
    throw new StructuredAgentSessionCreateUnknownOutcomeError(
      'The host could not say whether it forks chats.',
      'runtime_unavailable'
    )
  }
  abandonStructuredAgentSessionLaunchIntent(intent)
  throw new StructuredAgentSessionCreateRefusalError(
    STRUCTURED_LAUNCH_FORK_UNSUPPORTED_REFUSAL,
    STRUCTURED_LAUNCH_FORK_UNSUPPORTED_REFUSAL
  )
}

/** A no-send this attempt cannot settle a preceding lost create. */
export function refuseUnsentInheritedFork(
  intent: StructuredAgentSessionLaunchIntent,
  priorUnknown: boolean,
  error?: unknown
): never {
  if (priorUnknown) {
    throw new StructuredAgentSessionCreateUnknownOutcomeError(
      'The host could not confirm the fork.',
      'runtime_unavailable'
    )
  }
  const code =
    error instanceof StructuredAgentSessionCreateRefusalError &&
    error.code === STRUCTURED_LAUNCH_FORK_UNSUPPORTED_REFUSAL
      ? STRUCTURED_LAUNCH_FORK_UNSUPPORTED_REFUSAL
      : 'runtime_unavailable'
  abandonStructuredAgentSessionLaunchIntent(intent)
  throw new StructuredAgentSessionCreateRefusalError(code, code)
}

/** Restored intents have no row context; read only the requested child's saved journal. */
async function requiresInheritedOriginal(
  intent: StructuredAgentSessionLaunchIntent
): Promise<boolean> {
  const source = intent.params.forkFrom
  if (!source) {
    return false
  }
  if (intent.forkRequiresInheritedOriginal !== undefined) {
    return intent.forkRequiresInheritedOriginal
  }
  const agents = decodeAgentSessionAgentsResult(
    await callStructuredAgentSession(intent.target, AGENT_SESSION_AGENTS_METHOD, {})
  )
  const fork = agents?.find((row) => row.agent === intent.agent)?.capabilities.fork
  if (!fork) {
    throw new Error('Fork support is unavailable')
  }
  if (fork === 'checkpoint') {
    return false
  }
  const pages: AgentSessionHistoryPage[] = []
  let history = await callStructuredAgentSession<AgentSessionHistoryResult>(
    intent.target,
    'agentSession.history',
    { sessionId: source.sessionId, direction: 'tail', limit: 200 }
  )
  for (;;) {
    if (!history.ok) {
      throw new Error('Child history is unavailable')
    }
    pages.push(history.page)
    if (!history.page.hasOlder) {
      break
    }
    history = await callStructuredAgentSession<AgentSessionHistoryResult>(
      intent.target,
      'agentSession.history',
      {
        sessionId: source.sessionId,
        direction: 'before',
        cursor: history.page.window.oldest ?? undefined,
        limit: 200
      }
    )
  }
  const items: AgentJournalRenderItem[] = pages.toReversed().flatMap((page) => page.items)
  if (!items.some((item) => item.itemId === source.throughItemId)) {
    throw new Error('Child response is unavailable')
  }
  return nativeChatForkRequiresInheritedOriginal(items, fork, source.throughItemId, {
    submissions: pages.toReversed().flatMap((page) => page.submissions),
    latestTurn: pages[0]?.latestTurn
  })
}

/** The proof stays ephemeral; the actual create is pinned to its runtime on the sending socket. */
export async function inheritedForkCreateOptions(
  intent: StructuredAgentSessionLaunchIntent
): Promise<
  | { expectedEnvironmentRuntimeId: string; expectedEnvironmentPairingRevision: number | undefined }
  | undefined
> {
  const required = await requiresInheritedOriginal(intent)
  intent.forkRequiresInheritedOriginal = required
  if (!required) {
    return undefined
  }
  const support =
    intent.target.kind === 'local'
      ? await structuredAgentSessionHostCapabilityState(
          intent.target,
          AGENT_SESSION_CREATE_FORK_ORIGINAL_RUNTIME_CAPABILITY
        )
      : undefined
  if (support === 'unknown') {
    throw new Error('Original fork support is unavailable')
  }
  const proof =
    intent.target.kind === 'environment'
      ? await runtimeEnvironmentCapabilityProof(
          intent.target.environmentId,
          AGENT_SESSION_CREATE_FORK_ORIGINAL_RUNTIME_CAPABILITY
        )
      : undefined
  if (support === 'unsupported' || proof?.supported === false) {
    throw new StructuredAgentSessionCreateRefusalError(
      STRUCTURED_LAUNCH_FORK_UNSUPPORTED_REFUSAL,
      STRUCTURED_LAUNCH_FORK_UNSUPPORTED_REFUSAL
    )
  }
  return proof
    ? {
        expectedEnvironmentRuntimeId: proof.runtimeId,
        expectedEnvironmentPairingRevision: proof.pairingRevision
      }
    : undefined
}
