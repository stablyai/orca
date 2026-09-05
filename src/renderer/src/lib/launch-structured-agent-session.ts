import type { AgentSessionHandleProvider } from '../../../shared/agent-session-provider-handle'
import type {
  AgentSessionAttachResult,
  AgentSessionMutationEnvelope,
  AgentSessionMutationResult
} from '../../../shared/agent-session-wire'
import {
  createStructuredAgentSessionOperationId,
  structuredAgentSessionPayloadFingerprint
} from '../../../shared/structured-agent-session-mutation'
import { hasRuntimeRpcErrorCode } from '../../../shared/runtime-rpc-error-code'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { useAppStore } from '@/store'
import {
  clearWebSessionFocusIntentIfMatches,
  recordWebSessionFocusIntent,
  resolveWebSessionVisibleTabId
} from '@/runtime/web-session-focus-intent'
import { LOCAL_STRUCTURED_SESSION_OWNER } from '@/runtime/local-structured-session-tabs-sync'

type StructuredAgentSessionCreateParams = {
  envelope: AgentSessionMutationEnvelope
  worktree: string
  agent: AgentSessionHandleProvider
}

export type StructuredAgentSessionLaunchIntent = {
  sessionId: string
  worktreeId: string
  agent: AgentSessionHandleProvider
  params: StructuredAgentSessionCreateParams
}

export class StructuredAgentSessionCreateRefusalError extends Error {}

export function createStructuredAgentSessionLaunchIntent(
  worktreeId: string,
  agent: AgentSessionHandleProvider
): StructuredAgentSessionLaunchIntent {
  const sessionId = `${agent}_${crypto.randomUUID().replaceAll('-', '_')}`
  const fields = { worktree: toRuntimeWorktreeSelector(worktreeId), agent }
  const state = useAppStore.getState()
  recordWebSessionFocusIntent(
    { environmentId: LOCAL_STRUCTURED_SESSION_OWNER },
    worktreeId,
    `agent-session:${sessionId}`,
    undefined,
    resolveWebSessionVisibleTabId(state, worktreeId)
  )
  return {
    sessionId,
    worktreeId,
    agent,
    params: {
      envelope: {
        sessionId,
        clientOperationId: createStructuredAgentSessionOperationId(() => crypto.randomUUID()),
        expectedRuntimeFence: null,
        payloadFingerprint: structuredAgentSessionPayloadFingerprint({
          method: 'agentSession.create',
          sessionId,
          fields
        })
      },
      ...fields
    }
  }
}

export function abandonStructuredAgentSessionLaunchIntent(
  intent: StructuredAgentSessionLaunchIntent
): void {
  clearWebSessionFocusIntentIfMatches(
    { environmentId: LOCAL_STRUCTURED_SESSION_OWNER },
    intent.worktreeId,
    `agent-session:${intent.sessionId}`
  )
}

/** The host answers a worktree selector it cannot resolve yet with this rather than a verdict. */
const SELECTOR_NOT_RESOLVABLE_CODE = 'selector_not_found'

/**
 * A worktree is not resolvable for a beat after `createWorktree` resolves, so a probe fired
 * immediately after creation fails instead of answering. Measured window: under ~250ms. These
 * delays cover it with margin and bound the wait when the selector is genuinely absent.
 */
const CREATE_SUPPORT_RETRY_DELAYS_MS: readonly number[] = [50, 150, 300]

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Whether the executing host supports creating this session — retrying only while the host cannot
 * yet resolve the worktree.
 *
 * "Could not answer" and "answered no" are different states and only the second is a verdict.
 * Collapsing them sends a launch to the terminal because a selector was a beat late, which is
 * indistinguishable to the user from the gate refusing them. The retry is narrowed to that one
 * transient code so every other failure still refuses on the first ask.
 */
async function hostSupportsCreate(intent: StructuredAgentSessionLaunchIntent): Promise<boolean> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const support = await callStructuredAgentSession<{ supported: boolean; reason?: string }>(
        { kind: 'local' },
        'agentSession.createSupport',
        { worktree: intent.params.worktree, agent: intent.agent }
      )
      return support.supported === true
    } catch (error) {
      const retryDelayMs = CREATE_SUPPORT_RETRY_DELAYS_MS[attempt]
      if (
        retryDelayMs === undefined ||
        !hasRuntimeRpcErrorCode(error, SELECTOR_NOT_RESOLVABLE_CODE)
      ) {
        // An unanswered probe is still not a yes.
        return false
      }
      await delay(retryDelayMs)
    }
  }
}

/**
 * Only the host that will execute the session can answer whether it supports creating one there —
 * on Windows that means reading the provider child's process start time, which a client cannot
 * observe.
 *
 * Codex is absent on purpose: its answer is settled by the launch route and owned elsewhere, so
 * probing here would change Codex's wire traffic. Note that this early return is also why the
 * unresolvable-selector race above has never been able to refuse a Codex launch — the race is
 * identical for Codex, nothing asks. Whoever gives Codex a probe inherits it.
 */
async function requireHostCreateSupport(intent: StructuredAgentSessionLaunchIntent): Promise<void> {
  if (intent.agent !== 'claude') {
    return
  }
  if (!(await hostSupportsCreate(intent))) {
    abandonStructuredAgentSessionLaunchIntent(intent)
    throw new StructuredAgentSessionCreateRefusalError('structured_agent_session_unsupported')
  }
}

export async function launchStructuredAgentSession(
  intent: StructuredAgentSessionLaunchIntent
): Promise<Pick<AgentSessionAttachResult, 'sessionId' | 'fence'>> {
  await requireHostCreateSupport(intent)
  const result = await callStructuredAgentSession<
    AgentSessionMutationResult<AgentSessionAttachResult>
  >({ kind: 'local' }, 'agentSession.create', intent.params)
  if (!result.ok) {
    abandonStructuredAgentSessionLaunchIntent(intent)
    throw new StructuredAgentSessionCreateRefusalError(result.refusal.message)
  }
  return { sessionId: result.value.sessionId, fence: result.value.fence }
}
