import { structuredAgentSessionSettledSends } from '../../../../../shared/agent-session/requests/structured-agent-session-send-settlement'
import {
  AGENT_SESSION_SEND_SELECTION_RUNTIME_CAPABILITY,
  AGENT_SESSION_SEND_SKILLS_RUNTIME_CAPABILITY
} from '../../../../../shared/agent-session/agent-session-create-capabilities'
import { hasRuntimeRpcErrorCode } from '../../../../../shared/runtime-rpc-error-code'
import {
  isAgentSessionCreateAdmissionRefusal,
  isAgentSessionForkSourceAdmissionRefusal,
  isDefinitiveAgentSessionCreateRefusal
} from '../../../../../shared/agent-session/failures/agent-session-definitive-refusal'
import { readAgentSessionRefusalReference } from '../../../../../shared/agent-session/failures/agent-session-wire-refusals'
import { readAgentSessionErrorRefusal } from '../../../../../shared/agent-session/failures/agent-session-write-failure'
import { callStructuredAgentSession } from '@/runtime/native-chat/requests/structured-agent-session-call'
import {
  supportsStructuredAgentSessionCreateOptionsMode,
  structuredAgentSessionHostSupports,
  supportsStructuredAgentSessionCreateMessage
} from '@/runtime/native-chat/host-capabilities/structured-agent-session-host-support'
import { withFrameDrawnChatTabPlacement } from '../../../store/workspace-layout/frames/frame-drawn-chat-tab-placement'
import { publishStructuredAgentSessionCreateHydration } from './structured-agent-session-create-hydration'
import { askHostCreateSupport } from './structured-agent-session-host-admission'
import { readStructuredChatHostPermissionVerdict } from '@/runtime/native-chat/host-capabilities/structured-chat-host-permission'
import { abandonStructuredAgentSessionLaunchIntent } from './structured-agent-session-launch-abandon'
import {
  StructuredAgentSessionCreateError,
  StructuredAgentSessionCreateAbandonedError,
  StructuredAgentSessionCreateRefusalError,
  StructuredAgentSessionCreateUnknownOutcomeError
} from './structured-agent-session-launch-errors'
import {
  requireHostForkSupport,
  inheritedForkCreateOptions,
  refuseUnsentInheritedFork
} from './structured-agent-session-launch-fork-support'
import {
  RuntimeConnectionChangedBeforeSendError,
  RuntimeRpcCallError
} from '@/runtime/rpc/calls/runtime-rpc-result'
import type {
  AgentSessionAttachResult,
  AgentSessionMutationResult
} from '../../../../../shared/agent-session/agent-session-wire'
import type { StructuredAgentSessionCreateParams } from '../../../../../shared/agent-session/structured-agent-session-create'
import type { StructuredAgentSessionLaunchIntent } from './structured-agent-session-launch-intent'
import type { StructuredAgentLaunchReceipt } from './structured-agent-session-launch-recovery'

export { STRUCTURED_LAUNCH_FORK_UNSUPPORTED_REFUSAL } from './structured-agent-session-launch-fork-support'

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
  if (support.kind === 'refused') {
    abandonStructuredAgentSessionLaunchIntent(intent)
    const { code } = support.refusal
    throw new StructuredAgentSessionCreateRefusalError(code, code, support.refusal)
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
  // Gates only the intent it was set on, once; a user Retry builds a new intent without it.
  if (intent.createAfter) {
    const go = await intent.createAfter
    if (go instanceof StructuredAgentSessionCreateRefusalError) {
      throw go
    }
    if (!go) {
      abandonStructuredAgentSessionLaunchIntent(intent)
      throw new StructuredAgentSessionCreateAbandonedError('Conversation source kept its terminal.')
    }
    delete intent.createAfter
  }
  let forkOptions: Awaited<ReturnType<typeof inheritedForkCreateOptions>>
  if (intent.params.forkFrom) {
    try {
      forkOptions = await inheritedForkCreateOptions(intent)
    } catch (error) {
      refuseUnsentInheritedFork(intent, priorCreateOutcomeUnknown, error)
    }
  }
  await requireHostForkSupport(intent)
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
      intent.sendSelectionSupport = await structuredAgentSessionHostSupports(
        intent.target,
        AGENT_SESSION_SEND_SELECTION_RUNTIME_CAPABILITY
      )
      intent.sendSkillsSupport = await structuredAgentSessionHostSupports(
        intent.target,
        AGENT_SESSION_SEND_SKILLS_RUNTIME_CAPABILITY
      )
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
      params,
      ...(forkOptions ? ([forkOptions] as const) : ([] as const))
    )
  } catch (error) {
    if (
      forkOptions?.expectedEnvironmentRuntimeId &&
      (error instanceof RuntimeConnectionChangedBeforeSendError ||
        (error instanceof RuntimeRpcCallError && error.code === 'runtime_environment_changed'))
    ) {
      refuseUnsentInheritedFork(intent, priorCreateOutcomeUnknown)
    }
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
      (isAgentSessionCreateAdmissionRefusal(refusal) ||
        (!!intent.params.forkFrom && isAgentSessionForkSourceAdmissionRefusal(refusal)))
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
    ? structuredAgentSessionSettledSends(
        [
          ...(result.value.firstMessage ? [result.value.firstMessage] : []),
          ...result.value.page.submissions
        ],
        []
      ).recorded.get(intent.params.firstMessage.clientMessageId)
    : undefined
  if (intent.createMessageSupport === true) {
    publishStructuredAgentSessionCreateHydration(intent, result.value.page, result.value.fence)
  }
  if (
    intent.params.firstMessage &&
    firstMessage?.clientMessageId !== intent.params.firstMessage.clientMessageId
  ) {
    throw new StructuredAgentSessionCreateUnknownOutcomeError(
      'The created chat did not confirm its first message.',
      'agent_session_operation_unknown'
    )
  }
  return {
    sessionId: result.value.sessionId,
    fence: result.value.fence,
    ...(firstMessage ? { firstMessage, cursor: result.cursor } : {})
  }
}
