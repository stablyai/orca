import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { sendGeneratedTerminalInputToHandle } from '@/runtime/generated-terminal-input-client'
import type { GeneratedInputOutcome } from '../../../shared/generated-terminal-input'
import { GENERATED_AGENT_INPUT_TIMEOUT_MS } from '../../../shared/generated-agent-input-readiness'
import { deliverGeneratedPaste } from './agent-paste-draft'
import { toRemoteRuntimePtyId } from '../../../shared/remote-runtime/remote-runtime-pty-id'
import type { ActiveAgentNotesSendResult } from './active-agent-note-send-result'
import { getTerminalAgentSendReadiness } from './active-agent-terminal-send-readiness'
import { codeForReadinessStatus } from './active-agent-note-send-diagnostics'

/** A host too old for the guarded send: the same generated operation as every other notes send. */
export async function sendPromptWithLegacyCombinedSend(
  runtimeTarget: RuntimeClientTarget,
  terminalHandle: string,
  prompt: string
): Promise<ActiveAgentNotesSendResult> {
  return notesResultForOutcome(await deliverNotes(runtimeTarget, terminalHandle, prompt))
}

export async function sendPromptWithGuardedPasteAndEnter(
  runtimeTarget: RuntimeClientTarget,
  terminalHandle: string,
  prompt: string,
  options: { allowLegacyFallback: boolean }
): Promise<ActiveAgentNotesSendResult> {
  const initialAgentStatus = await getTerminalAgentSendReadiness(
    runtimeTarget,
    terminalHandle,
    options
  )
  if (
    initialAgentStatus.status !== 'sendable' &&
    !(initialAgentStatus.status === 'no-agent' && initialAgentStatus.supportsGuardedSend)
  ) {
    return {
      status: initialAgentStatus.status,
      code: initialAgentStatus.code ?? codeForReadinessStatus(initialAgentStatus.status)
    }
  }

  return notesResultForOutcome(await deliverNotes(runtimeTarget, terminalHandle, prompt))
}

/** Notes are generated input: a capable host runs its operation; an older paired host gets the
 *  same operation on this client's evidence of that terminal. The status checks above stay a
 *  pre-check only, never a substitute for the current input region. */
async function deliverNotes(
  runtimeTarget: RuntimeClientTarget,
  terminalHandle: string,
  prompt: string
): Promise<GeneratedInputOutcome> {
  const request = {
    text: prompt,
    submit: true,
    inputKind: 'driving' as const,
    intent: 'running' as const,
    timeoutMs: GENERATED_AGENT_INPUT_TIMEOUT_MS
  }
  const hosted = await sendGeneratedTerminalInputToHandle(runtimeTarget, terminalHandle, request)
  if (hosted !== null) {
    return hosted
  }
  // Only a paired environment can be older than this client; the local runtime never is.
  if (runtimeTarget.kind !== 'environment') {
    return 'not-sent'
  }
  return await deliverGeneratedPaste({
    ptyId: toRemoteRuntimePtyId(terminalHandle, runtimeTarget.environmentId),
    content: prompt,
    submit: true,
    inputKind: 'driving',
    intent: 'running',
    deadline: Date.now() + GENERATED_AGENT_INPUT_TIMEOUT_MS
  })
}

function notesResultForOutcome(outcome: GeneratedInputOutcome): ActiveAgentNotesSendResult {
  switch (outcome) {
    case 'delivered':
    case 'staged':
      return { status: 'sent' }
    case 'target-gone':
      return { status: 'no-active-terminal', code: 'terminal_gone' }
    case 'unconfirmed':
      return { status: 'partial-submit-failed', code: 'submit-readiness-lost' }
    case 'not-sent':
      return { status: 'not-ready', code: 'terminal_wait_blocked' }
  }
}
