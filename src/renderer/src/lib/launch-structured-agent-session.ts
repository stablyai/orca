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
import { resolveStructuredLaunchSeedOptions } from '../../../shared/native-chat-session-option-defaults'
import { hasRuntimeRpcErrorCode } from '../../../shared/runtime-rpc-error-code'
import { isDefinitiveAgentSessionCreateRefusal } from '../../../shared/agent-session-definitive-refusal'
import { readAgentSessionRefusalReference } from '../../../shared/agent-session-wire-refusals'
import { readAgentSessionErrorRefusal } from '../../../shared/agent-session-write-failure'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { useAppStore } from '@/store'
import {
  clearWebSessionFocusIntentIfMatches,
  recordWebSessionFocusIntent,
  resolveWebSessionVisibleTabId
} from '@/runtime/web-session-focus-intent'
import {
  resolveStructuredAgentSessionOwner,
  structuredAgentSessionFocusOwner,
  structuredAgentSessionTargetForHost
} from '@/runtime/structured-agent-session-owner'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { askHostCreateSupport } from '@/lib/structured-agent-session-host-admission'
import {
  StructuredAgentSessionCreateError,
  StructuredAgentSessionCreateRefusalError,
  StructuredAgentSessionCreateUnknownOutcomeError,
  StructuredAgentSessionOwnerUnresolvedError
} from '@/lib/structured-agent-session-launch-errors'

export {
  StructuredAgentSessionCreateRefusalError,
  StructuredAgentSessionCreateUnknownOutcomeError,
  StructuredAgentSessionOwnerUnresolvedError
}

export type StructuredAgentSessionLaunchIntent = {
  sessionId: string
  worktreeId: string
  /** The host that owns the chat, fixed when the launch begins and persisted with it: worktree ids
   *  repeat across hosts, so it is never re-derived. */
  executionHostId: ExecutionHostId
  /** The runtime serving `executionHostId`. */
  target: RuntimeClientTarget
  agent: AgentSessionHandleProvider
  params: StructuredAgentSessionCreateParams
  /** The saved selection create seeds, read when the intent is built. */
  seedOptions?: Readonly<Record<string, string>>
}

type LaunchSeed = Readonly<Record<string, string>> | undefined

/** What create will seed: this machine's saved selection for its own chats; for a paired server's,
 *  the server's own, which it reports when it admits the chat (absent from an older server). */
function launchSeedOptions(
  state: ReturnType<typeof useAppStore.getState>,
  owner: Pick<StructuredAgentSessionLaunchIntent, 'target'>,
  agent: AgentSessionHandleProvider,
  hostSeedOptions: LaunchSeed
): { seedOptions?: Readonly<Record<string, string>> } {
  const seedOptions =
    owner.target.kind === 'local'
      ? resolveStructuredLaunchSeedOptions(state.settings?.nativeChatSessionOptions, agent)
      : hostSeedOptions
  return seedOptions ? { seedOptions } : {}
}

function structuredAgentSessionOwnerTarget(
  worktreeId: string,
  executionHostId: ExecutionHostId | null
): { executionHostId: ExecutionHostId; target: RuntimeClientTarget } {
  const target = structuredAgentSessionTargetForHost(executionHostId)
  if (!executionHostId || !target) {
    throw new StructuredAgentSessionOwnerUnresolvedError(worktreeId)
  }
  return { executionHostId, target }
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

/** `executionHostId` is the host the launch was routed to; absent, the catalog must name exactly
 *  one, or the launch is refused rather than sent to whichever host a fallback picks. */
export function createStructuredAgentSessionLaunchIntent(
  worktreeId: string,
  agent: AgentSessionHandleProvider,
  executionHostId?: ExecutionHostId,
  resumeFrom?: StructuredAgentSessionResumeSource,
  hostSeedOptions?: LaunchSeed
): StructuredAgentSessionLaunchIntent {
  const owner = structuredAgentSessionOwnerTarget(
    worktreeId,
    executionHostId ?? resolveStructuredAgentSessionOwner(useAppStore.getState(), worktreeId)
  )
  const sessionId = createStructuredAgentSessionId(agent, createBrowserUuid)
  return buildStructuredAgentSessionLaunchIntent(
    worktreeId,
    owner,
    agent,
    sessionId,
    resumeFrom,
    hostSeedOptions
  )
}

function buildStructuredAgentSessionLaunchIntent(
  worktreeId: string,
  owner: Pick<StructuredAgentSessionLaunchIntent, 'executionHostId' | 'target'>,
  agent: AgentSessionHandleProvider,
  sessionId: string,
  resumeFrom: StructuredAgentSessionResumeSource | undefined,
  hostSeedOptions: LaunchSeed
): StructuredAgentSessionLaunchIntent {
  const state = useAppStore.getState()
  recordWebSessionFocusIntent(
    structuredAgentSessionFocusOwner(owner.target),
    worktreeId,
    `agent-session:${sessionId}`,
    undefined,
    resolveWebSessionVisibleTabId(state, worktreeId)
  )
  return {
    sessionId,
    worktreeId,
    executionHostId: owner.executionHostId,
    target: owner.target,
    agent,
    params: structuredAgentSessionCreateParams({
      sessionId,
      worktree: toRuntimeWorktreeSelector(worktreeId),
      agent,
      ...(resumeFrom ? { resumeFrom } : {}),
      randomUuid: createBrowserUuid
    }),
    ...launchSeedOptions(state, owner, agent, hostSeedOptions)
  }
}

/** A definitive refusal consumed its operation id, but the provisional tab still owns its session. */
export function retryStructuredAgentSessionLaunchIntent(
  intent: StructuredAgentSessionLaunchIntent
): StructuredAgentSessionLaunchIntent {
  return buildStructuredAgentSessionLaunchIntent(
    intent.worktreeId,
    intent,
    intent.agent,
    intent.sessionId,
    intent.params.resumeFrom,
    intent.seedOptions
  )
}

/** Rebuild a reload-surviving intent with the caller's current worktree selector. */
export function restoreStructuredAgentSessionLaunchIntent(args: {
  worktreeId: string
  executionHostId: ExecutionHostId
  sessionId: string
  agent: AgentSessionHandleProvider
  clientOperationId: string
  payloadFingerprint: string
  expectedRuntimeFence: number | null
  resumeFrom?: StructuredAgentSessionResumeSource
  /** A paired server's seed, kept with the launch so a reload shows what create runs. */
  seedOptions?: Readonly<Record<string, string>>
}): StructuredAgentSessionLaunchIntent {
  const state = useAppStore.getState()
  const { target } = structuredAgentSessionOwnerTarget(args.worktreeId, args.executionHostId)
  recordWebSessionFocusIntent(
    structuredAgentSessionFocusOwner(target),
    args.worktreeId,
    `agent-session:${args.sessionId}`,
    undefined,
    resolveWebSessionVisibleTabId(state, args.worktreeId)
  )
  return {
    sessionId: args.sessionId,
    worktreeId: args.worktreeId,
    executionHostId: args.executionHostId,
    target,
    agent: args.agent,
    params: {
      envelope: {
        sessionId: args.sessionId,
        clientOperationId: args.clientOperationId,
        expectedRuntimeFence: args.expectedRuntimeFence,
        payloadFingerprint: args.payloadFingerprint
      },
      worktree: toRuntimeWorktreeSelector(args.worktreeId),
      agent: args.agent,
      ...(args.resumeFrom ? { resumeFrom: args.resumeFrom } : {})
    },
    ...launchSeedOptions(state, { target }, args.agent, args.seedOptions)
  }
}

export function abandonStructuredAgentSessionLaunchIntent(
  intent: StructuredAgentSessionLaunchIntent
): void {
  clearWebSessionFocusIntentIfMatches(
    structuredAgentSessionFocusOwner(intent.target),
    intent.worktreeId,
    `agent-session:${intent.sessionId}`
  )
}

/**
 * Only the host that will execute the session can answer whether it supports creating one there —
 * on Windows that means reading the provider child's process start time, which a client cannot
 * observe. Both providers ask: the host classifies per agent, and Codex inherits the
 * unresolvable-selector retry above along with the probe. The unknown branch stays on the chat for
 * reconciliation: a retry may follow a create whose reply was lost. Answers the seed create will use.
 */
async function requireHostCreateSupport(
  intent: StructuredAgentSessionLaunchIntent
): Promise<LaunchSeed> {
  const support = await askHostCreateSupport(intent.target, intent.params.worktree, intent.agent)
  if (support.kind === 'unreachable') {
    throw new StructuredAgentSessionCreateUnknownOutcomeError(
      support.message,
      support.code,
      readAgentSessionErrorRefusal(support.error)
    )
  }
  if (support.kind === 'declined') {
    abandonStructuredAgentSessionLaunchIntent(intent)
    throw new StructuredAgentSessionCreateRefusalError(
      'structured_agent_session_unsupported',
      'structured_agent_session_unsupported'
    )
  }
  return support.seedOptions
}

/** Told the seed a paired server says this create will use, which may differ from an earlier
 *  attempt's; a local launch reads its own settings instead. */
export type StructuredLaunchHostSeedListener = (seedOptions: LaunchSeed) => void

export async function launchStructuredAgentSession(
  intent: StructuredAgentSessionLaunchIntent,
  onHostSeed?: StructuredLaunchHostSeedListener
): Promise<Pick<AgentSessionAttachResult, 'sessionId' | 'fence'>> {
  const hostSeed = await requireHostCreateSupport(intent)
  if (intent.target.kind !== 'local') {
    onHostSeed?.(hostSeed)
  }
  let result: AgentSessionMutationResult<AgentSessionAttachResult>
  try {
    result = await callStructuredAgentSession<AgentSessionMutationResult<AgentSessionAttachResult>>(
      intent.target,
      'agentSession.create',
      intent.params
    )
  } catch (error) {
    const code = definitiveStructuredAgentSessionCreateErrorCode(error)
    if (code) {
      abandonStructuredAgentSessionLaunchIntent(intent)
      throw new StructuredAgentSessionCreateRefusalError(
        error instanceof Error ? error.message : String(error),
        code,
        readAgentSessionErrorRefusal(error)
      )
    }
    throw error
  }
  if (!result.ok) {
    const { code, message, ownerVerdict } = result.refusal
    const refusal = readAgentSessionRefusalReference(result.refusal)
    // A failed operation whose provider is proven gone is a failure a new operation may retry.
    if (!isDefinitiveAgentSessionCreateRefusal(code) && ownerVerdict !== 'exited') {
      // Keep the focus intent: the session may exist, and recovery still has to adopt it.
      throw new StructuredAgentSessionCreateUnknownOutcomeError(message, code, refusal)
    }
    abandonStructuredAgentSessionLaunchIntent(intent)
    throw new StructuredAgentSessionCreateRefusalError(message, code, refusal)
  }
  return { sessionId: result.value.sessionId, fence: result.value.fence }
}
