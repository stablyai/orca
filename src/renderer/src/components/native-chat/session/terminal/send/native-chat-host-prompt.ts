import {
  RuntimeConnectionChangedBeforeSendError,
  RuntimeRpcCallError
} from '@/runtime/rpc/calls/runtime-rpc-result'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { runtimeEnvironmentCapabilityProof } from '@/runtime/rpc/compatibility/runtime-capability-proof'
import { getRemoteRuntimePtyOwner } from '@/runtime/hosted-terminals/identity/remote-runtime-pty-owner'
import { recordRuntimeTerminalInputForPtyId } from '@/runtime/hosted-terminals/input/runtime-terminal-input-recording'
import type { RuntimeTerminalResolvePane } from '../../../../../../../shared/runtime-terminal-contracts'
import type {
  RuntimeTerminalSend,
  TerminalChatPrompt
} from '../../../../../../../shared/runtime-terminal-send-contract'
import { TERMINAL_CHAT_PROMPT_EXPIRY_RUNTIME_CAPABILITY } from '../../../../../../../shared/terminal/runtime-policy/terminal-runtime-capabilities'
import { getTerminalInputByteLength } from '../../../../../../../shared/terminal/input/terminal-input'
import { reserveNativeChatPtyDispatch } from './native-chat-pty-send-queue'
import type {
  NativeChatPtySubmissionOutcome,
  NativeChatPtyDispatchScope
} from './native-chat-pty-send-queue'
import type { NativeChatSendHandle } from './native-chat-runtime-send'

import {
  mapTerminalChatExpiry,
  terminalChatPromptSchedule
} from '../../../../../../../shared/terminal/input/terminal-chat-prompt-budget'
import type { NativeChatPromptDispatch } from '../../../../../../../shared/native-chat/input/native-chat-prompt-observation'

const clockUpper = (): number => Math.ceil(performance.now()) + 1
const clockLower = (): number => Math.max(0, Math.floor(performance.now()) - 1)

/** FIFO dispatch only; after dispatch cancellation detaches and never sends compensating input. */
export function sendNativeChatHostPrompt({
  ptyId,
  paneKey,
  worktreeId,
  prompt: initialPrompt,
  onLegacy,
  onEvidenceMode,
  onBinding
}: {
  ptyId: string
  paneKey: string
  worktreeId?: string
  prompt: TerminalChatPrompt
  onLegacy: (scope: NativeChatPtyDispatchScope) => NativeChatSendHandle
  onEvidenceMode: (source: boolean) => void
  onBinding?: (binding: NativeChatPromptDispatch) => void
}): NativeChatSendHandle {
  const startedAt = clockLower()
  const bytes = getTerminalInputByteLength(initialPrompt.text)
  const reservation = reserveNativeChatPtyDispatch(ptyId, bytes)
  if (!reservation) {
    return {
      settlesOwnOutcome: true,
      cancel: () => {},
      settleAfterMs: 0,
      outcome: Promise.resolve('not-submitted'),
      dispatchOutcome: Promise.resolve('not-submitted'),
      settled: Promise.resolve()
    }
  }
  const lifetimeMs = terminalChatPromptSchedule(initialPrompt.text).lifetimeMs
  const deadline = startedAt + lifetimeMs
  let input: {
    prompt: TerminalChatPrompt
    onLegacy: typeof onLegacy
    onEvidenceMode: typeof onEvidenceMode
    onBinding: typeof onBinding
  } | null = { prompt: initialPrompt, onLegacy, onEvidenceMode, onBinding }
  let legacy: NativeChatSendHandle | null = null
  let dispatched = false
  let detached = false
  const active = (): boolean => !detached && clockUpper() < deadline
  const previous = reservation.previous
  let outcome: NativeChatPtySubmissionOutcome = 'not-submitted'
  let observerOutcome: NativeChatPtySubmissionOutcome | undefined
  const dispatchCompletion = Promise.withResolvers<NativeChatPtySubmissionOutcome>()
  const complete = Promise.withResolvers<void>()
  const physical = Promise.withResolvers<void>()
  let physicallyDone = false
  const finishDispatch = (value: NativeChatPtySubmissionOutcome): void => {
    if (physicallyDone) {
      return
    }
    physicallyDone = true
    outcome = value
    dispatchCompletion.resolve(value)
    physical.resolve()
    clearTimeout(timer)
  }
  const useLegacy = async (): Promise<void> => {
    if (!input) {
      return
    }
    dispatched = false
    handle.settlesOwnOutcome = undefined
    clearTimeout(timer)
    input.onEvidenceMode(false)
    legacy = input.onLegacy(reservation.scope)
    finishDispatch((await legacy.outcome) ?? 'submitted')
  }
  const operation = previous.then(async () => {
    try {
      if (!active() || !input) {
        return
      }
      const owner = getRemoteRuntimePtyOwner(ptyId)
      const target = owner?.target ?? { kind: 'local' as const }
      const proof = owner
        ? await runtimeEnvironmentCapabilityProof(
            owner.target.environmentId,
            TERMINAL_CHAT_PROMPT_EXPIRY_RUNTIME_CAPABILITY,
            deadline - clockUpper()
          )
        : null
      if (!active() || !input) {
        return
      }
      if (owner && proof?.supported !== true) {
        await useLegacy()
        return
      }
      const localStatus = await window.api.runtime.getStatus()
      const localReceiptUpper = clockUpper()
      if (!active() || !input) {
        return
      }
      if (!localStatus.capabilities?.includes(TERMINAL_CHAT_PROMPT_EXPIRY_RUNTIME_CAPABILITY)) {
        await useLegacy()
        return
      }
      const expiry = mapTerminalChatExpiry(
        localStatus.runtimeId,
        localStatus.elapsedClockMs!,
        deadline,
        localReceiptUpper
      )
      input.onEvidenceMode(true)
      const resolved = owner
        ? null
        : await callRuntimeRpc<{ terminal: RuntimeTerminalResolvePane }>(
            target,
            'terminal.resolvePane',
            { paneKey: paneKey, worktreeId: worktreeId }
          )
      if (!active() || !input) {
        return
      }
      if (resolved && resolved.terminal.ptyId !== ptyId) {
        outcome = 'not-submitted'
        return
      }
      const packet = {
        terminal: owner?.terminal ?? resolved!.terminal.handle,
        chatPrompt: { ...input.prompt, expiry },
        client: { id: 'orca-desktop', type: 'desktop' as const },
        ...(resolved?.terminal.incarnationId
          ? { expectedIncarnationId: resolved.terminal.incarnationId }
          : {})
      }
      dispatched = true
      const response = await callRuntimeRpc<{ send: RuntimeTerminalSend }>(
        target,
        'terminal.send',
        packet,
        {
          timeoutMs: Math.max(1, Math.ceil(deadline - clockUpper())),
          skipCompatibilityCheck: true,
          expectedEnvironmentPairingRevision: proof?.pairingRevision,
          expectedEnvironmentRuntimeId: proof?.runtimeId
        }
      )
      if (response.send.chatPromptNotDispatched === 'unsupported') {
        await useLegacy()
        return
      }
      recordRuntimeTerminalInputForPtyId(ptyId)
      outcome =
        response.send.writeSettlement?.outcome === 'accepted' && response.send.accepted
          ? 'submitted'
          : response.send.writeSettlement?.outcome !== 'refused'
            ? 'uncertain'
            : 'not-submitted'
      if (!physicallyDone && response.send.chatPromptBinding) {
        input?.onBinding?.({
          ...response.send.chatPromptBinding,
          terminalHandle: response.send.handle,
          targetPtyId: ptyId,
          runtimeEnvironmentId: owner?.target.environmentId ?? null
        })
      }
      finishDispatch(outcome)
    } catch (error) {
      const refusedBeforeWrite =
        error instanceof RuntimeConnectionChangedBeforeSendError ||
        (error instanceof RuntimeRpcCallError &&
          error.code === 'invalid_argument' &&
          ['invalid_terminal_send', 'Missing terminal send payload'].includes(
            error.response.error.message
          ))
      outcome = dispatched && !refusedBeforeWrite ? 'uncertain' : 'not-submitted'
      if (!dispatched || refusedBeforeWrite) {
        finishDispatch(outcome)
      }
    } finally {
      if (!dispatched) {
        finishDispatch(outcome)
      }
      input = null
      complete.resolve()
      reservation.releasePayload()
    }
  })
  // An expired follower cannot retire a still-live predecessor's physical reservation.
  const tail = Promise.all([previous, physical.promise]).then(() => {})
  const cancel = (keepInput = false): void => {
    detached = true
    input = null
    if (!dispatched && !legacy) {
      reservation.releasePayload()
      finishDispatch('not-submitted')
    }
    legacy?.cancel(keepInput)
    observerOutcome = dispatched ? 'uncertain' : 'not-submitted'
    complete.resolve()
  }
  let timer: ReturnType<typeof setTimeout>
  const expire = (): void => {
    const remaining = deadline - clockLower()
    if (remaining > 0) {
      timer = setTimeout(expire, Math.ceil(remaining))
      return
    }
    cancel()
    finishDispatch(dispatched ? 'uncertain' : 'not-submitted')
    reservation.releasePayload()
  }
  timer = setTimeout(expire, Math.ceil(deadline - clockLower()))
  const settled = complete.promise.then(() => {})
  void operation.finally(() => {
    input = null
  })
  const handle: NativeChatSendHandle & { settled: Promise<void> } = {
    settlesOwnOutcome: true,
    settleAfterMs: lifetimeMs,
    settled,
    outcome: settled.then(() => observerOutcome ?? outcome),
    dispatchOutcome: dispatchCompletion.promise,
    cancel
  }
  reservation.track(handle, tail)
  void tail.finally(() => clearTimeout(timer))
  return handle
}
