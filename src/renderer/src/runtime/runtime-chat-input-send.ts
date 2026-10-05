import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { RuntimeTerminalSend } from '../../../shared/runtime-types'
import type { NativeChatInputWriteResult } from '../../../shared/native-chat-input-action'
import { isTerminalInputTooLargeWithDeferredMeasurement } from '../../../shared/terminal-input'
import type { TerminalInputKind } from '../../../shared/terminal-input-kind'
import { classifyTerminalProcessInspectionFailure } from '../../../shared/terminal-process-inspection'
import { callRuntimeRpc, getActiveRuntimeTarget } from './runtime-rpc-client'
import {
  getRemoteRuntimePtyEnvironmentId,
  getRemoteRuntimeTerminalHandle
} from './runtime-terminal-stream'
import { recordRuntimeTerminalInputForPtyId } from './runtime-terminal-inspection'

const DESKTOP_RUNTIME_CLIENT = { id: 'orca-desktop', type: 'desktop' } as const

/** One composer action's identity on every write it makes (clear, body, Enter, answer step). */
export type RuntimeChatInputAction = {
  actionId: string
  /** The paired host refuses tagged writes after a proven exit; unused for this desktop's PTYs. */
  hostGuarded: boolean
  /** Set by the first refusal; later writes of the action are never dispatched. */
  refused: boolean
  /** Settled bytes of every earlier step; a refusal is clean only while this is zero. */
  bytesWritten?: number
  /** A pending view switch's answer: the action writes nothing unless it committed chat. */
  ready?: Promise<boolean>
  /** `nothingWritten`: no step of the action reached the PTY, so the input is safe to restore. */
  onRefused?: (refusal: { nothingWritten: boolean }) => void
}

const chatInputTailByPtyId = new Map<string, Promise<unknown>>()

/** One lane per PTY, entered synchronously at the call, before any measurement or wait. */
function enqueueChatInput<T>(ptyId: string, write: () => Promise<T>): Promise<T> {
  const previous = chatInputTailByPtyId.get(ptyId) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(write)
  chatInputTailByPtyId.set(ptyId, next)
  void next
    .catch(() => undefined)
    .finally(() => {
      if (chatInputTailByPtyId.get(ptyId) === next) {
        chatInputTailByPtyId.delete(ptyId)
      }
    })
  return next
}

const REFUSED: NativeChatInputWriteResult = { accepted: false, bytesWritten: 0 }
const DELIVERY_UNKNOWN: NativeChatInputWriteResult = {
  accepted: false,
  bytesWritten: 0,
  deliveryUnknown: true
}

function noteRefusal(action: RuntimeChatInputAction, result: NativeChatInputWriteResult): void {
  action.bytesWritten = (action.bytesWritten ?? 0) + result.bytesWritten
  if (!result.accepted && !result.deliveryUnknown && !action.refused) {
    action.refused = true
    action.onRefused?.({ nothingWritten: action.bytesWritten === 0 })
  }
}

/**
 * Writes one chat input step. Local PTYs (including SSH ones this desktop owns) go through the
 * guarded, settled IPC; a paired host gets `terminal.send` tagged with the action when it says it
 * guards. A refusal is final: there is no raw fallback that could type the text into a shell.
 */
export function sendRuntimeChatInput(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  ptyId: string,
  data: string,
  inputKind: TerminalInputKind,
  action: RuntimeChatInputAction
): Promise<NativeChatInputWriteResult> {
  // Why a lane: a large body's deferred measurement must never let its Enter overtake it.
  return enqueueChatInput(ptyId, () => sendChatInputStep(settings, ptyId, data, inputKind, action))
}

async function sendChatInputStep(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  ptyId: string,
  data: string,
  inputKind: TerminalInputKind,
  action: RuntimeChatInputAction
): Promise<NativeChatInputWriteResult> {
  if (action.refused) {
    return REFUSED
  }
  if (action.ready && !(await action.ready)) {
    noteRefusal(action, REFUSED)
    return REFUSED
  }
  const tooLarge = isTerminalInputTooLargeWithDeferredMeasurement(data)
  if (typeof tooLarge === 'boolean' ? tooLarge : await tooLarge) {
    return REFUSED
  }
  const ownerEnvironmentId = getRemoteRuntimePtyEnvironmentId(ptyId)
  const target = ownerEnvironmentId
    ? ({ kind: 'environment', environmentId: ownerEnvironmentId } as const)
    : getActiveRuntimeTarget(settings)
  const terminal = getRemoteRuntimeTerminalHandle(ptyId)
  const result =
    target.kind !== 'environment' || !terminal
      ? await window.api.pty
          .writeChatInput(ptyId, data, inputKind, action.actionId)
          .catch(() => DELIVERY_UNKNOWN)
      : await sendPairedChatInput(target, terminal, data, action)
  if (result.accepted) {
    recordRuntimeTerminalInputForPtyId(ptyId)
  }
  noteRefusal(action, result)
  return result
}

function sendPairedChatInput(
  target: { kind: 'environment'; environmentId: string },
  terminal: string,
  data: string,
  action: RuntimeChatInputAction
): Promise<NativeChatInputWriteResult> {
  return callRuntimeRpc<{ send: RuntimeTerminalSend }>(
    target,
    'terminal.send',
    {
      terminal,
      text: data,
      client: DESKTOP_RUNTIME_CLIENT,
      ...(action.hostGuarded ? { chatInput: { actionId: action.actionId } } : {})
    },
    { timeoutMs: 15_000 }
  ).then(
    ({ send }) => ({
      accepted: send.accepted === true,
      bytesWritten: send.bytesWritten,
      ...(send.refusedReason === 'agent-exited' ? { refusedReason: send.refusedReason } : {}),
      ...(send.deliveryUnknown ? { deliveryUnknown: true as const } : {})
    }),
    (error: unknown) =>
      classifyTerminalProcessInspectionFailure(error) === 'terminal_gone'
        ? REFUSED
        : DELIVERY_UNKNOWN
  )
}
