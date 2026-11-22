import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store/index'
import {
  createAuxiliaryFingerprint,
  createStructuredAgentSessionOperationId
} from '../../../../../shared/agent-session/lifecycle/operations/structured-agent-session-mutation'
import { createNonSecureContextUuid } from '../../../../../shared/identifiers/non-secure-context-uuid'
import { structuredAgentSessionSendBody } from '../../../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { hasRuntimeRpcErrorCode } from '../../../../../shared/remote-runtime/rpc/runtime-rpc-error-code'
import { createOrcaSessionId } from '../../../../../shared/agent-session/identity/orca-session-address'
import { isRecord } from '../../../../../shared/agent-status/child-work/agent-status-child-work-value-guards'
import { callStructuredAgentSession } from '@/runtime/native-chat/requests/structured-agent-session-call'
import { structuredAgentSessionHostCapabilityState } from '@/runtime/native-chat/host-capabilities/structured-agent-session-host-support'
import { AGENT_SESSION_CREATE_AUXILIARY_RUNTIME_CAPABILITY } from '../../../../../shared/agent-session/lifecycle/operations/agent-session-create-capabilities'
import { withNativeChatAuxiliaryReferences } from '@/components/native-chat/selection-quotes/native-chat-auxiliary-references'
import {
  nativeChatAuxiliaryNextTitleNumber,
  selectNativeChatAuxiliaryConversation,
  type NativeChatAuxiliaryChild,
  type NativeChatAuxiliaryParent
} from '@/store/slices/right-sidebar/native-chat-auxiliary-state'
import type { StructuredAgentSessionFirstMessage } from '../../../../../shared/agent-session/lifecycle/operations/structured-agent-session-create'

/** Text a source selection wants appended to the active same-parent child's draft. */
export type NativeChatAuxiliaryReferenceInput = {
  sourceRowId: string
  text: string
}

export type NativeChatAuxiliaryCreateOutcome =
  | { child: NativeChatAuxiliaryChild }
  | { refused: string }

function auxiliaryCreateSessionId(result: unknown): string | null {
  if (!isRecord(result)) {
    return null
  }
  if (isRecord(result.value) && typeof result.value.sessionId === 'string') {
    return result.value.sessionId
  }
  return typeof result.sessionId === 'string' ? result.sessionId : null
}

function auxiliaryCreateRefusal(result: unknown): { code: string | null; message: string | null } {
  if (!isRecord(result)) {
    return { code: null, message: null }
  }
  const refusal = isRecord(result.refusal) ? result.refusal : null
  if (!refusal) {
    return { code: null, message: null }
  }
  return {
    code: typeof refusal.code === 'string' ? refusal.code : null,
    message: typeof refusal.message === 'string' ? refusal.message : null
  }
}

function hostOlderRefusal(): string {
  return translate(
    'components.rightSidebar.sideChat.hostOlder',
    'This host runs an older Orca. Update it to use side chats.'
  )
}

function createFailureRefusal(error: unknown, result?: unknown): string {
  const failure = auxiliaryCreateRefusal(result)
  if (failure.code === 'method_not_found') {
    return hostOlderRefusal()
  }
  if (hasRuntimeRpcErrorCode(error, 'method_not_found')) {
    return hostOlderRefusal()
  }
  if (failure.message && failure.message !== failure.code) {
    return failure.message
  }
  if (error instanceof Error && error.message) {
    return error.message
  }
  return translate(
    'components.rightSidebar.sideChat.createFailed',
    "The side chat couldn't start. Try again."
  )
}

function buildFirstMessage(
  parentSessionId: string,
  question: string,
  reference: NativeChatAuxiliaryReferenceInput | undefined
): StructuredAgentSessionFirstMessage {
  const text =
    reference === undefined
      ? question
      : withNativeChatAuxiliaryReferences(question, [
          {
            sourceSessionId: parentSessionId,
            sourceRowId: reference.sourceRowId,
            text: reference.text
          }
        ])
  return {
    clientMessageId: createStructuredAgentSessionOperationId(createNonSecureContextUuid),
    body: structuredAgentSessionSendBody(text, [])
  }
}

/** Creates the unlisted child and registers it; routing/focus belong to the caller. */
export async function createNativeChatAuxiliaryChild(
  parent: NativeChatAuxiliaryParent,
  question: string | undefined,
  reference: NativeChatAuxiliaryReferenceInput | undefined
): Promise<NativeChatAuxiliaryCreateOutcome> {
  const hostState = await structuredAgentSessionHostCapabilityState(
    parent.target,
    AGENT_SESSION_CREATE_AUXILIARY_RUNTIME_CAPABILITY
  )
  if (hostState !== 'supported') {
    return { refused: hostOlderRefusal() }
  }
  const sessionId = createOrcaSessionId(createNonSecureContextUuid)
  const firstMessage = question
    ? buildFirstMessage(parent.sessionId, question, reference)
    : undefined
  const envelope = {
    sessionId,
    clientOperationId: createStructuredAgentSessionOperationId(createNonSecureContextUuid),
    expectedRuntimeFence: null,
    payloadFingerprint: createAuxiliaryFingerprint({
      sessionId,
      parentSessionId: parent.sessionId,
      ...(firstMessage ? { firstMessage } : {})
    })
  }
  let result: unknown
  try {
    result = await callStructuredAgentSession<unknown>(
      parent.target,
      'agentSession.createAuxiliary',
      {
        parentSessionId: parent.sessionId,
        envelope,
        ...(firstMessage ? { firstMessage } : {})
      }
    )
  } catch (error) {
    return { refused: createFailureRefusal(error) }
  }
  if (isRecord(result) && result.ok === false) {
    return { refused: createFailureRefusal(undefined, result) }
  }
  const createdSessionId = auxiliaryCreateSessionId(result)
  if (!createdSessionId) {
    return { refused: createFailureRefusal(undefined) }
  }
  const state = useAppStore.getState()
  const existing = selectNativeChatAuxiliaryConversation(state, parent)
  const child: NativeChatAuxiliaryChild = {
    sessionId: createdSessionId,
    parentSessionId: parent.sessionId,
    parentTabId: parent.tabId,
    worktreeId: parent.worktreeId,
    target: parent.target,
    agent: parent.agent as NativeChatAuxiliaryChild['agent'],
    titleNumber: nativeChatAuxiliaryNextTitleNumber(existing?.children ?? []),
    createdAt: Date.now()
  }
  state.addNativeChatAuxiliaryChild(parent, child)
  return { child }
}
