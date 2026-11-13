import {
  RuntimeConnectionChangedBeforeSendError,
  RuntimeRpcCallError
} from '@/runtime/rpc/calls/runtime-rpc-result'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { runtimeEnvironmentCapabilityProof } from '@/runtime/rpc/compatibility/runtime-capability-proof'
import { ensureLocalRuntimeCapabilities } from '@/runtime/hosts/capabilities/local-runtime-capabilities'
import { getRemoteRuntimePtyOwner } from '@/runtime/hosted-terminals/identity/remote-runtime-pty-owner'
import { recordRuntimeTerminalInputForPtyId } from '@/runtime/hosted-terminals/input/runtime-terminal-input-recording'
import type { RuntimeTerminalResolvePane } from '../../../../../../../shared/runtime-terminal-contracts'
import type {
  RuntimeTerminalSend,
  TerminalChatPrompt
} from '../../../../../../../shared/runtime-terminal-send-contract'
import { TERMINAL_CHAT_PROMPT_RUNTIME_CAPABILITY } from '../../../../../../../shared/terminal/runtime-policy/terminal-runtime-capabilities'
import { getTerminalInputByteLength } from '../../../../../../../shared/terminal/input/terminal-input'
import { reserveNativeChatPtyDispatch } from './native-chat-pty-send-queue'
import type {
  NativeChatPtySubmissionOutcome,
  NativeChatPtyDispatchScope
} from './native-chat-pty-send-queue'
import type { NativeChatSendHandle } from './native-chat-runtime-send'

const OBSERVATION_MS = 65_000

/** FIFO dispatch only; after dispatch cancellation detaches and never sends compensating input. */
export function sendNativeChatHostPrompt({
  ptyId,
  paneKey,
  worktreeId,
  prompt: initialPrompt,
  onLegacy,
  onEvidenceMode
}: {
  ptyId: string
  paneKey: string
  worktreeId?: string
  prompt: TerminalChatPrompt
  onLegacy: (scope: NativeChatPtyDispatchScope) => NativeChatSendHandle
  onEvidenceMode: (source: boolean) => void
}): NativeChatSendHandle {
  const deadline = performance.now() + OBSERVATION_MS
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
  let input: {
    prompt: TerminalChatPrompt
    onLegacy: typeof onLegacy
    onEvidenceMode: typeof onEvidenceMode
  } | null = { prompt: initialPrompt, onLegacy, onEvidenceMode }
  let legacy: NativeChatSendHandle | null = null
  let dispatched = false
  let detached = false
  const active = (): boolean => !detached && performance.now() < deadline
  const previous = reservation.previous
  let outcome: NativeChatPtySubmissionOutcome = 'not-submitted'
  let observerOutcome: NativeChatPtySubmissionOutcome | undefined
  const dispatchCompletion = Promise.withResolvers<NativeChatPtySubmissionOutcome>()
  const complete = Promise.withResolvers<void>()
  const expired = Promise.withResolvers<void>()
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
            TERMINAL_CHAT_PROMPT_RUNTIME_CAPABILITY,
            deadline - performance.now()
          )
        : null
      const supported =
        proof?.supported ??
        (await ensureLocalRuntimeCapabilities())?.includes(TERMINAL_CHAT_PROMPT_RUNTIME_CAPABILITY)
      if (!active() || !input) {
        return
      }
      if (supported !== true) {
        handle.settlesOwnOutcome = undefined
        clearTimeout(timer)
        input.onEvidenceMode(false)
        legacy = input.onLegacy(reservation.scope)
        outcome = (await legacy.outcome) ?? 'submitted'
        return
      }
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
        chatPrompt: input.prompt,
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
          timeoutMs: Math.max(1, deadline - performance.now()),
          skipCompatibilityCheck: true,
          expectedEnvironmentPairingRevision: proof?.pairingRevision,
          expectedEnvironmentRuntimeId: proof?.runtimeId
        }
      )
      recordRuntimeTerminalInputForPtyId(ptyId)
      outcome =
        response.send.writeSettlement?.outcome === 'accepted' && response.send.accepted
          ? 'submitted'
          : response.send.writeSettlement?.outcome !== 'refused'
            ? 'uncertain'
            : 'not-submitted'
    } catch (error) {
      const refusedBeforeWrite =
        error instanceof RuntimeConnectionChangedBeforeSendError ||
        (error instanceof RuntimeRpcCallError &&
          error.code === 'invalid_argument' &&
          ['invalid_terminal_send', 'Missing terminal send payload'].includes(
            error.response.error.message
          ))
      outcome = dispatched && !refusedBeforeWrite ? 'uncertain' : 'not-submitted'
    } finally {
      dispatchCompletion.resolve(outcome)
      input = null
      complete.resolve()
      reservation.releasePayload()
    }
  })
  const tail = Promise.race([operation, expired.promise]).then(
    () => {},
    () => {}
  )
  const cancel = (keepInput = false): void => {
    detached = true
    input = null
    if (!dispatched) {
      reservation.releasePayload()
      dispatchCompletion.resolve('not-submitted')
    }
    legacy?.cancel(keepInput)
    observerOutcome = dispatched ? 'uncertain' : 'not-submitted'
    complete.resolve()
  }
  const timer = setTimeout(() => {
    cancel()
    dispatchCompletion.resolve(dispatched ? 'uncertain' : 'not-submitted')
    reservation.releasePayload()
    expired.resolve()
  }, OBSERVATION_MS)
  const settled = complete.promise.then(() => {})
  void operation.finally(() => {
    clearTimeout(timer)
    input = null
  })
  const handle: NativeChatSendHandle & { settled: Promise<void> } = {
    settlesOwnOutcome: true,
    settleAfterMs: OBSERVATION_MS,
    settled,
    outcome: settled.then(() => observerOutcome ?? outcome),
    dispatchOutcome: dispatchCompletion.promise,
    cancel
  }
  reservation.track(handle, tail)
  void tail.finally(() => clearTimeout(timer))
  return handle
}
