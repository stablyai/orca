import type { AgentSessionHandleProvider } from '../../../shared/agent-session-provider-handle'
import type {
  AgentSessionAttachResult,
  AgentSessionMutationResult
} from '../../../shared/agent-session-wire'
import {
  createStructuredAgentSessionId,
  structuredAgentSessionCreateParams,
  type StructuredAgentSessionCreateParams,
  type StructuredAgentSessionResumeSource
} from '../../../shared/structured-agent-session-create'
import { hasRuntimeRpcErrorCode } from '../../../shared/runtime-rpc-error-code'
import { isDefinitiveAgentSessionCreateRefusal } from '../../../shared/agent-session-definitive-refusal'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { useAppStore } from '@/store'
import {
  clearWebSessionFocusIntentIfMatches,
  recordWebSessionFocusIntent,
  resolveWebSessionVisibleTabId
} from '@/runtime/web-session-focus-intent'
import { LOCAL_STRUCTURED_SESSION_OWNER } from '@/runtime/local-structured-session-tabs-sync'

export type StructuredAgentSessionLaunchIntent = {
  sessionId: string
  worktreeId: string
  agent: AgentSessionHandleProvider
  params: StructuredAgentSessionCreateParams
}

class StructuredAgentSessionCreateError extends Error {
  constructor(
    message: string,
    /** The wire refusal code, or the RPC error code when the create never reached a handler. */
    readonly code: string
  ) {
    super(message)
  }
}

/**
 * The host proved it created nothing, so a caller may open a legacy terminal instead. The class
 * itself is the verdict: `launchStructuredAgentSession` is the only place that decides it, against
 * the shared allowlist, so no consumer has to remember to re-check a code.
 */
export class StructuredAgentSessionCreateRefusalError extends StructuredAgentSessionCreateError {
  constructor(message: string, code: string = 'structured_agent_session_unsupported') {
    super(message, code)
    this.name = 'StructuredAgentSessionCreateRefusalError'
  }
}

/**
 * Refused with a code that does not prove the session is absent. A sibling opened here would sit
 * beside a session the host may already hold, so this deliberately is NOT a refusal error: it flows
 * down the same path as a lost reply, which replays the intent and reconciles.
 */
export class StructuredAgentSessionCreateUnknownOutcomeError extends StructuredAgentSessionCreateError {
  constructor(message: string, code: string) {
    super(message, code)
    this.name = 'StructuredAgentSessionCreateUnknownOutcomeError'
  }
}

const DEFINITIVE_CREATE_FAILURE_CODES = [
  'structured_agent_session_unsupported',
  'method_not_found'
] as const

function definitiveStructuredAgentSessionCreateErrorCode(error: unknown): string | null {
  if (error instanceof StructuredAgentSessionCreateError) {
    // Our own classes already carry the verdict; message sniffing below could only invert it.
    return error instanceof StructuredAgentSessionCreateRefusalError &&
      isDefinitiveAgentSessionCreateRefusal(error.code)
      ? error.code
      : null
  }
  for (const code of DEFINITIVE_CREATE_FAILURE_CODES) {
    if (hasRuntimeRpcErrorCode(error, code)) {
      return code
    }
  }
  return null
}

export function isDefinitiveStructuredAgentSessionCreateError(error: unknown): boolean {
  return definitiveStructuredAgentSessionCreateErrorCode(error) !== null
}

export function createStructuredAgentSessionLaunchIntent(
  worktreeId: string,
  agent: AgentSessionHandleProvider,
  resumeFrom?: StructuredAgentSessionResumeSource
): StructuredAgentSessionLaunchIntent {
  const sessionId = createStructuredAgentSessionId(agent, () => crypto.randomUUID())
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
    params: structuredAgentSessionCreateParams({
      sessionId,
      worktree: toRuntimeWorktreeSelector(worktreeId),
      agent,
      ...(resumeFrom ? { resumeFrom } : {}),
      randomUuid: () => crypto.randomUUID()
    })
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
 * observe. Both providers ask: the host classifies per agent, and Codex inherits the
 * unresolvable-selector retry above along with the probe.
 */
async function requireHostCreateSupport(intent: StructuredAgentSessionLaunchIntent): Promise<void> {
  if (!(await hostSupportsCreate(intent))) {
    abandonStructuredAgentSessionLaunchIntent(intent)
    throw new StructuredAgentSessionCreateRefusalError(
      'structured_agent_session_unsupported',
      'structured_agent_session_unsupported'
    )
  }
}

export async function launchStructuredAgentSession(
  intent: StructuredAgentSessionLaunchIntent
): Promise<Pick<AgentSessionAttachResult, 'sessionId' | 'fence'>> {
  await requireHostCreateSupport(intent)
  let result: AgentSessionMutationResult<AgentSessionAttachResult>
  try {
    result = await callStructuredAgentSession<AgentSessionMutationResult<AgentSessionAttachResult>>(
      { kind: 'local' },
      'agentSession.create',
      intent.params
    )
  } catch (error) {
    const code = definitiveStructuredAgentSessionCreateErrorCode(error)
    if (code) {
      abandonStructuredAgentSessionLaunchIntent(intent)
      throw new StructuredAgentSessionCreateRefusalError(
        error instanceof Error ? error.message : String(error),
        code
      )
    }
    throw error
  }
  if (!result.ok) {
    const { code, message } = result.refusal
    if (!isDefinitiveAgentSessionCreateRefusal(code)) {
      // Keep the focus intent: the session may exist, and recovery still has to adopt it.
      throw new StructuredAgentSessionCreateUnknownOutcomeError(message, code)
    }
    abandonStructuredAgentSessionLaunchIntent(intent)
    throw new StructuredAgentSessionCreateRefusalError(message, code)
  }
  return { sessionId: result.value.sessionId, fence: result.value.fence }
}
