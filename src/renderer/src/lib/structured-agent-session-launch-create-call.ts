import type {
  AgentSessionAttachResult,
  AgentSessionMutationResult
} from '../../../shared/agent-session-wire'
import { hasRuntimeRpcErrorCode } from '../../../shared/runtime-rpc-error-code'
import {
  isAgentSessionCreateAdmissionRefusal,
  isDefinitiveAgentSessionCreateRefusal
} from '../../../shared/agent-session-definitive-refusal'
import { readAgentSessionRefusalReference } from '../../../shared/agent-session-wire-refusals'
import { readAgentSessionErrorRefusal } from '../../../shared/agent-session-write-failure'
import {
  callStructuredAgentSession,
  supportsStructuredAgentSessionCreateOptionsMode,
  supportsStructuredAgentSessionCreateMessage
} from '@/runtime/structured-agent-session-client'
import type { StructuredAgentSessionCreateParams } from '../../../shared/structured-agent-session-create'
import { withFrameDrawnChatTabPlacement } from './frame-drawn-chat-tab-placement'
import { publishStructuredAgentSessionCreateHydration } from './structured-agent-session-create-hydration'
import { askHostCreateSupport } from './structured-agent-session-host-admission'
import { readStructuredChatHostPermissionVerdict } from '@/runtime/structured-chat-host-permission'
import {
  abandonStructuredAgentSessionLaunchIntent,
  type StructuredAgentSessionLaunchIntent
} from './launch-structured-agent-session'
import type { StructuredAgentLaunchReceipt } from './agent-session/launch/structured-agent-session-launch-recovery'
import {
  StructuredAgentSessionCreateError,
  StructuredAgentSessionCreateAbandonedError,
  StructuredAgentSessionCreateRefusalError,
  StructuredAgentSessionCreateUnknownOutcomeError
} from './structured-agent-session-launch-errors'

type LaunchSeed = Readonly<Record<string, string>> | undefined
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

/** Only the executing host can classify create support for either provider. Retry unresolvable selectors; unknown attempts stay recoverable because create may have succeeded with a lost reply. Return the actual create seed. */
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
  if (support.kind === 'declined' || support.kind === 'workspace-unresolved') {
    abandonStructuredAgentSessionLaunchIntent(intent)
    throw new StructuredAgentSessionCreateRefusalError(
      'structured_agent_session_unsupported',
      'structured_agent_session_unsupported',
      undefined,
      support.kind === 'declined' ? support.reason : undefined
    )
  }
  return support.seedOptions
}

/** Refuse paired hosts that would grant more access than requested; the chat permission gate owns the explanation. */
const STRUCTURED_LAUNCH_HOST_PERMISSION_REFUSAL = 'structured_agent_session_host_permission'

async function requireHostPermission(intent: StructuredAgentSessionLaunchIntent): Promise<void> {
  const permission =
    intent.target.kind === 'local'
      ? { kind: 'allowed' as const }
      : await readStructuredChatHostPermissionVerdict(intent.target, intent.agent)
  if (permission.kind === 'allowed') {
    return
  }
  if (permission.kind === 'unverified') {
    throw new StructuredAgentSessionCreateUnknownOutcomeError(
      'The host could not say what access the chat would run with.',
      'runtime_unavailable'
    )
  }
  abandonStructuredAgentSessionLaunchIntent(intent)
  throw new StructuredAgentSessionCreateRefusalError(
    STRUCTURED_LAUNCH_HOST_PERMISSION_REFUSAL,
    STRUCTURED_LAUNCH_HOST_PERMISSION_REFUSAL
  )
}

// Use each paired attempt’s actual seed; local creates read local settings instead.
export type StructuredLaunchHostSeedListener = (seedOptions: LaunchSeed) => void

export async function launchStructuredAgentSession(
  intent: StructuredAgentSessionLaunchIntent,
  onHostSeed?: StructuredLaunchHostSeedListener,
  priorCreateOutcomeUnknown = false,
  /** A chat closed while its host was being asked issues no create. */
  isCancelled: () => boolean = () => false
): Promise<StructuredAgentLaunchReceipt> {
  const hostSeed = await requireHostCreateSupport(intent)
  if (intent.target.kind !== 'local') {
    onHostSeed?.(hostSeed)
  }
  await requireHostPermission(intent)
  if (!intent.createPrepared) {
    let supported = false
    let takesExplicitOptions = false
    try {
      supported = await supportsStructuredAgentSessionCreateMessage(intent.target)
      takesExplicitOptions =
        supported &&
        intent.explicitLaunchOptions !== undefined &&
        (await supportsStructuredAgentSessionCreateOptionsMode(intent.target))
    } catch {
      // Unknown capability stays on the compatible create path.
    }
    if (!intent.createPrepared) {
      intent.createMessageSupport = supported
      intent.prepareCreate?.(takesExplicitOptions)
      intent.createPrepared = true
    }
  }
  let result: AgentSessionMutationResult<AgentSessionAttachResult>
  // Typed so an async placement fails to compile: a tick here drops an eager joiner's create.
  const params: StructuredAgentSessionCreateParams = withFrameDrawnChatTabPlacement(intent)
  // Nothing is created for a chat closed while its host was asked, or whose source retired.
  if (isCancelled() || intent.beforeCreate?.() === false) {
    abandonStructuredAgentSessionLaunchIntent(intent)
    throw new StructuredAgentSessionCreateAbandonedError(
      'Conversation source retired before create.'
    )
  }
  delete intent.beforeCreate
  try {
    result = await callStructuredAgentSession<AgentSessionMutationResult<AgentSessionAttachResult>>(
      intent.target,
      'agentSession.create',
      params
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
    const attemptRefusedBeforeCommit =
      !priorCreateOutcomeUnknown &&
      result.refusal.createAttemptRefusedBeforeCommit === true &&
      refusal !== undefined &&
      isAgentSessionCreateAdmissionRefusal(refusal)
    // Attempt proof cannot settle an earlier create whose reply was lost.
    if (
      !attemptRefusedBeforeCommit &&
      !isDefinitiveAgentSessionCreateRefusal(code) &&
      ownerVerdict !== 'exited'
    ) {
      // Keep the focus intent: the session may exist, and recovery still has to adopt it.
      throw new StructuredAgentSessionCreateUnknownOutcomeError(message, code, refusal)
    }
    abandonStructuredAgentSessionLaunchIntent(intent)
    throw new StructuredAgentSessionCreateRefusalError(message, code, refusal)
  }
  const firstMessage = intent.params.firstMessage
    ? (result.value.firstMessage ??
      result.value.page.submissions.find(
        (submission) => submission.clientMessageId === intent.params.firstMessage?.clientMessageId
      ))
    : undefined
  if (
    intent.params.firstMessage &&
    firstMessage?.clientMessageId !== intent.params.firstMessage.clientMessageId
  ) {
    throw new StructuredAgentSessionCreateUnknownOutcomeError(
      'The created chat did not confirm its first message.',
      'agent_session_operation_unknown'
    )
  }
  if (intent.createMessageSupport === true) {
    publishStructuredAgentSessionCreateHydration(intent, result.value.page, result.value.fence)
  }
  return {
    sessionId: result.value.sessionId,
    fence: result.value.fence,
    ...(firstMessage ? { firstMessage, cursor: result.cursor } : {})
  }
}
