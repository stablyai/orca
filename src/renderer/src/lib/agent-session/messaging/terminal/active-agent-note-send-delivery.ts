import type { RuntimeTerminalSend } from '../../../../../../shared/runtime-terminal-send-contract'
import {
  sanitizeBracketedPasteText as sanitizeTerminalPasteText,
  BRACKETED_PASTE_START as BRACKETED_PASTE_BEGIN,
  BRACKETED_PASTE_END
} from '../../../../../../shared/terminal/input/terminal-bracketed-paste-text'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import '../paste/agent-paste-draft'
import { AGENT_PROMPT_POST_PASTE_SUBMIT_DELAY_MS as POST_PASTE_SUBMIT_DELAY_MS } from '../../../../../../shared/agent-launch/startup/agent-prompt-injection'
import type { ActiveAgentNotesSendResult } from './active-agent-note-send-result'
import {
  ACTIVE_AGENT_SEND_RPC_TIMEOUT_MS,
  getTerminalAgentSendReadiness,
  isRuntimeTerminalNotWritable,
  isRuntimeTerminalUnavailable
} from './active-agent-terminal-send-readiness'
import { codeForReadinessStatus, runtimeFailureCode } from './active-agent-note-send-diagnostics'
import { runInTerminalSendLane, type TerminalSendLane } from './active-agent-terminal-send-lane'

const ORCA_DESKTOP_TERMINAL_CLIENT = { id: 'orca-desktop', type: 'desktop' as const }

/** Wait the host asks for before Enter; a host that names none keeps the fixed delay. */
function postPasteSubmitDelayMs(send: RuntimeTerminalSend): number {
  const hostDelayMs = send.submitDelayMs
  return typeof hostDelayMs === 'number' && Number.isFinite(hostDelayMs)
    ? Math.max(POST_PASTE_SUBMIT_DELAY_MS, hostDelayMs)
    : POST_PASTE_SUBMIT_DELAY_MS
}

/** Longest Orca holds a note's Enter itself. A paste that needs longer is left for the user to
 *  submit: they could type into the agent's input during the wait, and Enter would send that too. */
const MAX_HELD_SUBMIT_DELAY_MS = 5_000

/** Longest a send waits for its turn on a terminal another send is using. */
const MAX_LANE_WAIT_MS = 20_000

function waitMs(delayMs: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, delayMs))
}

async function runSendInLane(
  runtimeTarget: Parameters<typeof callRuntimeRpc>[0],
  terminalHandle: string,
  send: (lane: TerminalSendLane) => Promise<ActiveAgentNotesSendResult>,
  ptyId?: string
): Promise<ActiveAgentNotesSendResult> {
  const result = await runInTerminalSendLane(
    runtimeTarget,
    terminalHandle,
    send,
    MAX_LANE_WAIT_MS,
    ptyId
  )
  // Nothing was written.
  return 'laneBusy' in result ? { status: 'not-ready', code: 'terminal-send-busy' } : result
}

export function sendPromptWithLegacyCombinedSend(
  runtimeTarget: Parameters<typeof callRuntimeRpc>[0],
  terminalHandle: string,
  prompt: string,
  submit = true
): Promise<ActiveAgentNotesSendResult> {
  return runSendInLane(runtimeTarget, terminalHandle, () =>
    sendLegacyCombined(runtimeTarget, terminalHandle, prompt, submit)
  )
}

async function sendLegacyCombined(
  runtimeTarget: Parameters<typeof callRuntimeRpc>[0],
  terminalHandle: string,
  prompt: string,
  submit: boolean
): Promise<ActiveAgentNotesSendResult> {
  try {
    const { send } = await callRuntimeRpc<{ send: RuntimeTerminalSend }>(
      runtimeTarget,
      'terminal.send',
      {
        terminal: terminalHandle,
        text: prompt,
        enter: submit,
        client: ORCA_DESKTOP_TERMINAL_CLIENT
      },
      { timeoutMs: ACTIVE_AGENT_SEND_RPC_TIMEOUT_MS }
    )
    return send.accepted
      ? { status: 'sent' }
      : { status: 'not-writable', code: 'terminal-send-refused' }
  } catch (error) {
    if (isRuntimeTerminalUnavailable(error)) {
      return {
        status: 'no-active-terminal',
        code: runtimeFailureCode(error) ?? 'runtime-unverifiable'
      }
    }
    if (isRuntimeTerminalNotWritable(error)) {
      return { status: 'not-writable', code: 'terminal_not_writable' }
    }
    throw error
  }
}

export function sendPromptWithGuardedPasteAndEnter(
  runtimeTarget: Parameters<typeof callRuntimeRpc>[0],
  terminalHandle: string,
  prompt: string,
  options: GuardedSendOptions
): Promise<ActiveAgentNotesSendResult> {
  return runSendInLane(
    runtimeTarget,
    terminalHandle,
    (lane) => sendGuardedPasteAndEnter(runtimeTarget, terminalHandle, prompt, options, lane),
    options.ptyId
  )
}

type GuardedSendOptions = { allowLegacyFallback: boolean; submit?: boolean; ptyId?: string }

async function sendGuardedPasteAndEnter(
  runtimeTarget: Parameters<typeof callRuntimeRpc>[0],
  terminalHandle: string,
  prompt: string,
  options: GuardedSendOptions,
  lane: TerminalSendLane
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
    if (initialAgentStatus.status === 'no-active-terminal') {
      lane.setUnsentPaste(undefined)
    }
    return {
      status: initialAgentStatus.status,
      code: initialAgentStatus.code ?? codeForReadinessStatus(initialAgentStatus.status)
    }
  }

  const leftUnsent = options.submit === false
  const earlier = lane.unsentPaste()
  const draftResolved =
    earlier?.inputGeneration !== undefined &&
    initialAgentStatus.resolvedInputGeneration !== undefined &&
    initialAgentStatus.resolvedInputGeneration > earlier.inputGeneration
  // Only a deliberate submit or cancellation resolves a manual draft; editing preserves its fence.
  const awaitsUserEnter = earlier?.awaitsUserEnter === true && !draftResolved
  if (awaitsUserEnter && !leftUnsent) {
    // This send's Enter would submit a note the user was told to send themselves.
    return {
      status: 'not-ready',
      code: 'terminal-draft-pending',
      pasteSettleMs: Math.max(0, earlier.settlesAt - Date.now())
    }
  }
  // An Enter lands inside the earlier paste until that has settled, whoever owns it now.
  const carriedSettleMs = earlier ? Math.max(0, earlier.settlesAt - Date.now()) : 0

  const pastePayload = `${BRACKETED_PASTE_BEGIN}${sanitizeTerminalPasteText(prompt)}${BRACKETED_PASTE_END}`
  let submitDelayMs: number
  let inputGeneration: number | undefined
  try {
    const { send } = await callRuntimeRpc<{ send: RuntimeTerminalSend }>(
      runtimeTarget,
      'terminal.send',
      {
        terminal: terminalHandle,
        text: pastePayload,
        requireAgentStatus: 'sendable',
        client: ORCA_DESKTOP_TERMINAL_CLIENT
      },
      { timeoutMs: ACTIVE_AGENT_SEND_RPC_TIMEOUT_MS }
    )
    if (!send.accepted) {
      if (send.refusedReason === 'permission') {
        return { status: 'permission', code: 'terminal-send-permission' }
      }
      if (send.refusedReason === 'no-agent') {
        return { status: 'no-agent', code: 'no-agent' }
      }
      return { status: 'not-writable', code: 'terminal-send-refused' }
    }
    submitDelayMs = postPasteSubmitDelayMs(send) + carriedSettleMs
    if (typeof send.inputGeneration === 'number' && Number.isSafeInteger(send.inputGeneration)) {
      inputGeneration = send.inputGeneration
    }
  } catch (error) {
    if (isRuntimeTerminalUnavailable(error)) {
      return {
        status: 'no-active-terminal',
        code: runtimeFailureCode(error) ?? 'runtime-unverifiable'
      }
    }
    if (isRuntimeTerminalNotWritable(error)) {
      return { status: 'not-writable', code: 'terminal_not_writable' }
    }
    throw error
  }

  // Without submit the pasted text waits, editable, in the agent's input (Add to chat).
  if (leftUnsent || submitDelayMs > MAX_HELD_SUBMIT_DELAY_MS) {
    lane.setUnsentPaste({
      settlesAt: Date.now() + submitDelayMs,
      inputGeneration,
      awaitsUserEnter: !leftUnsent || awaitsUserEnter
    })
    return leftUnsent ? { status: 'sent' } : { status: 'pasted', pasteSettleMs: submitDelayMs }
  }
  // This send's own Enter submits whatever the terminal holds.
  lane.setUnsentPaste(undefined)
  await waitMs(submitDelayMs)
  try {
    const submitAgentStatus = await getTerminalAgentSendReadiness(
      runtimeTarget,
      terminalHandle,
      options
    )
    if (
      submitAgentStatus.status !== 'sendable' &&
      !(submitAgentStatus.status === 'no-agent' && submitAgentStatus.supportsGuardedSend)
    ) {
      return {
        status: 'partial-submit-failed',
        code: submitAgentStatus.code ?? 'submit-readiness-lost'
      }
    }
  } catch (error) {
    if (isRuntimeTerminalUnavailable(error)) {
      return {
        status: 'partial-submit-failed',
        code: runtimeFailureCode(error) ?? 'submit-terminal-unavailable'
      }
    }
    throw error
  }

  try {
    const { send } = await callRuntimeRpc<{ send: RuntimeTerminalSend }>(
      runtimeTarget,
      'terminal.send',
      {
        terminal: terminalHandle,
        enter: true,
        requireAgentStatus: 'sendable',
        // The host refuses this Enter if the terminal took any other input since the paste.
        ...(inputGeneration === undefined ? {} : { expectInputGeneration: inputGeneration }),
        client: ORCA_DESKTOP_TERMINAL_CLIENT
      },
      { timeoutMs: ACTIVE_AGENT_SEND_RPC_TIMEOUT_MS }
    )
    if (send.accepted) {
      return { status: 'sent' }
    }
    if (send.refusedReason === 'input-changed') {
      lane.setUnsentPaste({
        settlesAt: Date.now(),
        inputGeneration: send.inputGeneration,
        awaitsUserEnter: true
      })
      return { status: 'pasted', code: 'submit-send-refused' }
    }
    return { status: 'partial-submit-failed', code: 'submit-send-refused' }
  } catch (error) {
    if (isRuntimeTerminalUnavailable(error) || isRuntimeTerminalNotWritable(error)) {
      return { status: 'partial-submit-failed', code: 'submit-send-error' }
    }
    throw error
  }
}
