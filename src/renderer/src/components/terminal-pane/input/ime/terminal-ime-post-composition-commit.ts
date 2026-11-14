import {
  isNativeTextKeydown,
  MODIFIER_KEYDOWN_KEYS,
  stripTrailingCommittedText,
  type ClaimedKeyPress,
  type PendingCommit
} from './terminal-ime-claimed-key-records'
import {
  readTerminalImeCompositionSessionDetail,
  XTERM_COMPOSITION_SESSION_END_EVENT,
  XTERM_COMPOSITION_SESSION_START_EVENT
} from './terminal-ime-composition-route'

export const XTERM_COMPOSITION_TRANSACTION_ACCEPTED_EVENT = 'xterm-composition-transaction-accepted'
export const XTERM_COMPOSITION_TRANSACTION_SETTLED_EVENT = 'xterm-composition-transaction-settled'

type TxPhase = 'idle' | 'normal' | 'cancel' | 'cancel_queued' | 'expect' | 'sent' | 'await'
type CancelStep = 'none' | 'bs' | 'cancelled'
type EndState = 'open' | 'ended' | 'early_empty' | 'early_sent'
type EndSnapshot = { endData: string; expectsPost: boolean; cancelled: boolean; accepted: boolean }

export type TerminalImePostCompositionCommitArgs = {
  terminalElement: HTMLElement
  getPendingCommit: () => PendingCommit | null
  matchesPendingCommitText: (press: ClaimedKeyPress, data: string | null) => boolean
  onQueueRawCommit: (committedText: string) => void
  onFlushDeferredCommits: () => void
  onSendPostCompositionCommit: (text: string) => void
  onBlurFlushAndCancel: () => void
  onDisposeCancel: () => void
}

const asTextarea = (target: EventTarget | null): HTMLTextAreaElement | null =>
  target instanceof HTMLTextAreaElement ? target : null

const hasValue = (target: EventTarget | null): boolean =>
  (asTextarea(target)?.value.length ?? 0) > 0

const stripIfTextarea = (target: EventTarget | null, text: string): void => {
  const textarea = asTextarea(target)
  if (textarea) {
    stripTrailingCommittedText(textarea, text)
  }
}

const isKey = (event: KeyboardEvent, name: 'Escape' | 'Backspace'): boolean =>
  event.key === name || event.code === name

const isAwaitFlushKeydown = (event: KeyboardEvent): boolean =>
  event.key !== 'Process' &&
  event.keyCode !== 229 &&
  !MODIFIER_KEYDOWN_KEYS.has(event.key) &&
  !isNativeTextKeydown(event, false)

const isCancelInput = (event: InputEvent): boolean =>
  event.inputType === 'deleteContentBackward' || !hasValue(event.target)

/** Tracks DOM/xterm composition lifecycle so async Linux IBus Hangul commits survive finalizer races. */
export function installTerminalImePostCompositionCommit(
  args: TerminalImePostCompositionCommitArgs
) {
  const { terminalElement } = args
  let trackedTextarea: HTMLTextAreaElement | null = null
  let sessionId: number | null = null
  let phase: TxPhase = 'idle'
  let composing = false
  let sawInsertText = false
  let lastData = ''
  let cancelStep: CancelStep = 'none'
  let endState: EndState = 'open'
  let txSawExternalText = false
  let endSnapshot: EndSnapshot | null = null

  const inTx = (): boolean => phase !== 'idle' && phase !== 'await'
  const flushAwait = (): void => {
    if (phase === 'await') {
      phase = 'idle'
      args.onFlushDeferredCommits()
    }
  }
  const resetAll = (): void => {
    phase = 'idle'
    composing = false
    sawInsertText = false
    lastData = ''
    cancelStep = 'none'
    endState = 'open'
    txSawExternalText = false
    endSnapshot = null
  }
  const onBlur = (): void => {
    args.onBlurFlushAndCancel()
    resetAll()
  }
  const bindTextarea = (target: EventTarget | null): void => {
    const textarea = asTextarea(target)
    if (!textarea || textarea === trackedTextarea) {
      return
    }
    trackedTextarea?.removeEventListener('blur', onBlur)
    trackedTextarea = textarea
    trackedTextarea.addEventListener('blur', onBlur)
  }
  const emitCommit = (target: EventTarget | null, text: string): void => {
    stripIfTextarea(target, text)
    args.onSendPostCompositionCommit(text)
    args.onFlushDeferredCommits()
  }

  const offs: (() => void)[] = []
  const listen = (type: string, handler: EventListener, capture = true): void => {
    terminalElement.addEventListener(type, handler, capture)
    offs.push(() => terminalElement.removeEventListener(type, handler, capture))
  }

  const onDomComposition = (event: Event): void => {
    bindTextarea(event.target)
    if (event.type === 'compositionstart') {
      flushAwait()
      composing = true
      sawInsertText = false
      lastData = ''
      cancelStep = 'none'
      endState = 'open'
      endSnapshot = null
      return
    }
    if (event.type === 'compositionupdate') {
      composing = true
      const data = event instanceof CompositionEvent ? event.data : ''
      if (data.length > 0) {
        lastData = data
        cancelStep = 'none'
      } else if (cancelStep === 'bs') {
        cancelStep = 'cancelled'
      }
      return
    }
    const endData = event instanceof CompositionEvent ? (event.data ?? '') : ''
    const hasText = hasValue(event.target)
    const cancelled =
      cancelStep === 'cancelled' || (cancelStep === 'bs' && !hasText && endData.length === 0)
    const expectsPost = !cancelled && !endData && !sawInsertText && !hasText && lastData.length > 0
    composing = false
    txSawExternalText = false
    endSnapshot = { endData, expectsPost, cancelled, accepted: false }
  }
  for (const type of ['compositionstart', 'compositionupdate', 'compositionend']) {
    listen(type, onDomComposition)
  }
  listen('keydown', (event) => {
    bindTextarea(event.target)
    if (!(event instanceof KeyboardEvent)) {
      return
    }
    if (!composing) {
      if (phase === 'await' && isAwaitFlushKeydown(event)) {
        flushAwait()
      }
      return
    }
    if (isKey(event, 'Escape')) {
      cancelStep = 'cancelled'
    } else if (isKey(event, 'Backspace') && cancelStep === 'none') {
      cancelStep = 'bs'
    }
  })
  listen('keypress', () => {
    if (inTx()) {
      txSawExternalText = true
    }
  })
  listen(
    'compositionend',
    (event) => {
      const snap = endSnapshot
      const state = endState
      if (!snap || snap.accepted || state === 'open') {
        return
      }
      endState = state === 'ended' ? 'ended' : 'open'
      endSnapshot = null
      if (state === 'early_empty' && !snap.cancelled) {
        if (snap.endData.length > 0 && !sawInsertText) {
          emitCommit(event.target, snap.endData)
        } else if (snap.expectsPost) {
          phase = 'await'
        }
      }
    },
    false
  )
  listen(XTERM_COMPOSITION_SESSION_START_EVENT, (event) => {
    const detail = readTerminalImeCompositionSessionDetail(event)
    if (!detail) {
      return
    }
    sessionId = detail.id
    endState = 'open'
    endSnapshot = null
  })
  listen(XTERM_COMPOSITION_SESSION_END_EVENT, (event) => {
    const detail = readTerminalImeCompositionSessionDetail(event)
    if (detail !== null && sessionId !== null && detail.id !== sessionId) {
      return
    }
    const data = detail?.data ?? ''
    if (composing && !detail?.dataPendingReconciliation) {
      endState = data.length > 0 ? 'early_sent' : 'early_empty'
      return
    }
    endState = 'ended'
    const staleEmpty =
      !sawInsertText && !endSnapshot?.endData && !hasValue(event.target) && !txSawExternalText
    const blockStale = staleEmpty && (phase === 'cancel' || phase === 'expect')
    if (data.length > 0 && (phase === 'sent' || phase === 'cancel_queued' || blockStale)) {
      event.preventDefault()
      return
    }
    if (data.length > 0 && phase === 'expect') {
      phase = 'normal'
    } else if (!composing && !inTx() && endSnapshot && !endSnapshot.accepted) {
      const expects = endSnapshot.expectsPost && data.length === 0
      endSnapshot = null
      if (expects) {
        phase = 'await'
      }
    }
  })
  listen(XTERM_COMPOSITION_TRANSACTION_ACCEPTED_EVENT, () => {
    if (endSnapshot) {
      endSnapshot.accepted = true
    }
    phase = endSnapshot?.cancelled ? 'cancel' : endSnapshot?.expectsPost ? 'expect' : 'normal'
    txSawExternalText = false
  })
  listen(XTERM_COMPOSITION_TRANSACTION_SETTLED_EVENT, () => {
    const shouldAwait = phase === 'expect'
    phase = shouldAwait ? 'await' : 'idle'
    txSawExternalText = false
    endSnapshot = null
    if (!shouldAwait) {
      args.onFlushDeferredCommits()
    }
  })
  listen('blur', (event) => {
    if (!trackedTextarea || event.target !== trackedTextarea) {
      onBlur()
    }
  })

  return {
    isTransactionPending: inTx,
    expectsPostInput: () => phase === 'expect',
    observeInputBeforeForwarding: (event: InputEvent): void => {
      bindTextarea(event.target)
      if (!composing) {
        if (inTx() && event.inputType === 'insertCompositionText' && hasValue(event.target)) {
          txSawExternalText = true
        }
        return
      }
      if (event.inputType === 'insertText' && event.data) {
        sawInsertText = true
        cancelStep = 'none'
      } else if (cancelStep === 'bs' && isCancelInput(event)) {
        cancelStep = 'cancelled'
      }
    },
    consumePostCompositionInput: (event: InputEvent): boolean => {
      if (event.inputType !== 'insertText') {
        return false
      }
      const pending = args.getPendingCommit()
      if ((phase === 'cancel' || phase === 'cancel_queued') && !pending) {
        if (event.data) {
          phase = 'cancel_queued'
          stripIfTextarea(event.target, event.data)
          args.onQueueRawCommit(event.data)
        }
        event.stopImmediatePropagation()
        return true
      }
      if (phase !== 'expect' && phase !== 'await') {
        return false
      }
      if (pending && args.matchesPendingCommitText(pending.press, event.data)) {
        flushAwait()
        return false
      }
      const inTxPost = phase === 'expect'
      phase = inTxPost ? 'sent' : 'idle'
      if (event.data) {
        emitCommit(event.target, event.data)
      } else if (!inTxPost) {
        args.onFlushDeferredCommits()
      }
      event.stopImmediatePropagation()
      return true
    },
    dispose: () => {
      trackedTextarea?.removeEventListener('blur', onBlur)
      trackedTextarea = null
      args.onDisposeCancel()
      resetAll()
      for (const off of offs) {
        off()
      }
    }
  }
}
