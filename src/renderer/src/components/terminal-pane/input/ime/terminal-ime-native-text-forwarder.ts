import type { IDisposable } from '@xterm/xterm'
import { encodeImeCommitForKitty } from './terminal-ime-kitty-commit-encoding'
import { getLayoutCharacterForCode } from '../../../../lib/keyboard-layout/layout-base-character'
import { installTerminalImeRetainedHangulCommit } from './terminal-ime-retained-hangul-commit'
import {
  copyReleaseEvent,
  createClaimedKeyReleaseTracker,
  isNativeTextKeydown,
  matchesClaimedPress,
  MODIFIER_KEYDOWN_KEYS,
  stripTrailingCommittedText,
  type ClaimedKeyPress,
  type DeferredCommit,
  type ImeNativeTextKeyEvent,
  type PendingCommit
} from './terminal-ime-claimed-key-records'
import {
  installTerminalImePostCompositionCommit,
  XTERM_COMPOSITION_TRANSACTION_ACCEPTED_EVENT,
  XTERM_COMPOSITION_TRANSACTION_SETTLED_EVENT
} from './terminal-ime-post-composition-commit'

// Claim plain printable keydowns so native input commits supply substituted text before xterm can cancel it; Linux fcitx4 candidate picks need the same path (#28213). Match key length, never source identity or character tables.

export type { ImeNativeTextKeyEvent }

export { XTERM_COMPOSITION_TRANSACTION_ACCEPTED_EVENT, XTERM_COMPOSITION_TRANSACTION_SETTLED_EVENT }

export type TerminalImeNativeTextForwarder = IDisposable & {
  /** Claim the key lifecycle by bypassing xterm; input later forwards the committed text through sendInput. */
  claimKeyEvent: (event: ImeNativeTextKeyEvent) => boolean
}

export function installTerminalImeNativeTextForwarder(args: {
  terminalElement: HTMLElement | null | undefined
  isComposing: () => boolean
  sendInput: (data: string) => void
  /** Read negotiated flags once per commit; keydown ownership stays protocol-blind. Omission means no negotiating pane. */
  getKittyKeyboardFlags?: () => number
}): TerminalImeNativeTextForwarder {
  if (!args.terminalElement) {
    return {
      claimKeyEvent: () => false,
      dispose: () => undefined
    }
  }

  const terminalElement = args.terminalElement
  let pendingCommit: PendingCommit | null = null
  // Commits that arrived while an xterm composition transaction was settling wait in order.
  const deferredPostCompositionCommits: DeferredCommit[] = []
  const {
    findClaimedRecordId,
    settleRelease,
    settleCommit,
    clear: clearClaimedKeyRecords
  } = createClaimedKeyReleaseTracker({
    sendInput: args.sendInput,
    getKittyKeyboardFlags: args.getKittyKeyboardFlags
  })
  const retainedHangulCommit = installTerminalImeRetainedHangulCommit({
    terminalElement,
    sendInput: args.sendInput,
    getKittyKeyboardFlags: () => args.getKittyKeyboardFlags?.() ?? 0
  })

  const matchesPendingCommitText = (press: ClaimedKeyPress, data: string | null): boolean => {
    if (!data) {
      return false
    }
    if (data === press.key) {
      return true
    }
    return press.code ? data === getLayoutCharacterForCode(press.code, press.shiftKey) : false
  }

  const flushDeferredPostCompositionCommits = (): void => {
    if (deferredPostCompositionCommits.length === 0) {
      return
    }
    const deferred = deferredPostCompositionCommits.splice(0)
    for (const entry of deferred) {
      if (entry.kind === 'raw') {
        args.sendInput(entry.committedText)
        continue
      }
      const encoding = encodeImeCommitForKitty(
        entry.commit.press,
        args.getKittyKeyboardFlags?.() ?? 0,
        {
          committedText: entry.committedText,
          layoutCharacterForCode: getLayoutCharacterForCode
        }
      )
      args.sendInput(encoding.report ?? entry.committedText)
      settleCommit(entry.commit, encoding.release)
    }
  }

  // Dispose discards held records without flushing; blur flushes already-stripped deferred commits first.
  const cancelPending = (): void => {
    pendingCommit = null
    deferredPostCompositionCommits.length = 0
    clearClaimedKeyRecords()
  }

  const postComposition = installTerminalImePostCompositionCommit({
    terminalElement,
    getPendingCommit: () => pendingCommit,
    matchesPendingCommitText,
    onQueueRawCommit: (committedText) => {
      deferredPostCompositionCommits.push({ kind: 'raw', committedText })
    },
    onFlushDeferredCommits: flushDeferredPostCompositionCommits,
    onSendPostCompositionCommit: (text) => {
      args.sendInput(text)
    },
    onBlurFlushAndCancel: () => {
      flushDeferredPostCompositionCommits()
      cancelPending()
    },
    onDisposeCancel: cancelPending
  })

  const claimKeyEvent = (event: ImeNativeTextKeyEvent): boolean => {
    if (event.type === 'keydown') {
      if (pendingCommit && matchesClaimedPress(event, pendingCommit.press)) {
        // Settle repeated same-key pending claims before an early keyup’s owed release can be overwritten.
        settleCommit(pendingCommit, null)
        pendingCommit = null
      } else if (pendingCommit && !MODIFIER_KEYDOWN_KEYS.has(event.key)) {
        // Retire swallowed claims without timers but retain their keyup tombstones; bare modifiers cannot retire a still-inbound commit.
        settleCommit(pendingCommit, null)
        pendingCommit = null
      }
      if (event.repeat !== true) {
        // Why: a fresh same-key press proves the prior press ended; settle its owed release first.
        const staleRecordId = findClaimedRecordId(event)
        if (staleRecordId !== null) {
          settleRelease(staleRecordId, {
            key: event.key,
            code: event.code,
            shiftKey: event.shiftKey === true,
            ctrlKey: event.ctrlKey,
            altKey: event.altKey,
            metaKey: event.metaKey,
            capsLock: event.getModifierState?.('CapsLock') === true,
            numLock: event.getModifierState?.('NumLock') === true
          })
        }
      }
      if (!isNativeTextKeydown(event, args.isComposing())) {
        return false
      }
      pendingCommit = {
        press: {
          key: event.key,
          code: event.code,
          shiftKey: event.shiftKey === true,
          repeat: event.repeat === true,
          capsLock: event.getModifierState?.('CapsLock') === true,
          numLock: event.getModifierState?.('NumLock') === true
        },
        keyup: null
      }
      return true
    }
    if (event.type === 'keyup') {
      if (pendingCommit && matchesClaimedPress(event, pendingCommit.press)) {
        // Copy actual keyup modifiers now; they may differ from press-time state before commit arrives.
        pendingCommit.keyup = copyReleaseEvent(event)
        return true
      }
      for (let index = deferredPostCompositionCommits.length - 1; index >= 0; index -= 1) {
        const deferred = deferredPostCompositionCommits[index]
        if (
          deferred.kind === 'claimed' &&
          !deferred.commit.keyup &&
          matchesClaimedPress(event, deferred.commit.press)
        ) {
          deferred.commit.keyup = copyReleaseEvent(event)
          return true
        }
      }
      const recordId = findClaimedRecordId(event)
      if (recordId === null) {
        return false
      }
      // Application negotiation can outlive xterm’s reset; encode releases here to avoid missing or mismatched reports.
      settleRelease(recordId, copyReleaseEvent(event))
      return true
    }
    // Bypass keypress without retiring the pending commit so xterm cannot double-send text.
    return event.type === 'keypress' && pendingCommit !== null
  }

  const forwardCommittedText = (event: Event): void => {
    if (!(event instanceof InputEvent)) {
      return
    }
    postComposition.observeInputBeforeForwarding(event)
    // Accepted transactions already own claimed commits; leave unclaimed input to xterm’s dedup or Linux Process commits can be lost.
    if (
      postComposition.isTransactionPending() &&
      event.inputType === 'insertText' &&
      pendingCommit
    ) {
      // Async IME commits arriving right after an empty compositionend look unclaimed if a later plain keydown beat them.
      if (
        postComposition.expectsPostInput() &&
        !matchesPendingCommitText(pendingCommit.press, event.data) &&
        postComposition.consumePostCompositionInput(event)
      ) {
        return
      }
      // Claimed key echoes (e.g. Space or punctuation right after compositionend) must wait for settled so order and Kitty encoding survive.
      if (event.data) {
        if (event.target instanceof HTMLTextAreaElement) {
          stripTrailingCommittedText(event.target, event.data)
        }
        deferredPostCompositionCommits.push({
          kind: 'claimed',
          commit: pendingCommit,
          committedText: event.data
        })
        pendingCommit = null
        event.stopImmediatePropagation()
        return
      }
      settleCommit(pendingCommit, null)
      pendingCommit = null
      event.stopImmediatePropagation()
      return
    }
    if (postComposition.consumePostCompositionInput(event)) {
      return
    }
    const commit = pendingCommit
    if (!commit) {
      return
    }
    pendingCommit = null
    if (event.inputType !== 'insertText') {
      // Non-text takeover leaves only keyup suppression because this press delivered no text.
      settleCommit(commit, null)
      return
    }
    if (event.data) {
      // Read mutable flags once at commit so the release matches the press’s negotiation.
      const encoding = encodeImeCommitForKitty(commit.press, args.getKittyKeyboardFlags?.() ?? 0, {
        committedText: event.data,
        layoutCharacterForCode: getLayoutCharacterForCode
      })
      args.sendInput(encoding.report ?? event.data)
      settleCommit(commit, encoding.release)
    } else {
      settleCommit(commit, null)
    }
    event.stopImmediatePropagation()
    // Clear committed text: macOS reads preceding field contents for double-space period substitution (#11504).
    if (
      event.target instanceof HTMLTextAreaElement &&
      !(event.data && retainedHangulCommit.retain(event.target, event.data))
    ) {
      event.target.value = ''
    }
  }

  terminalElement.addEventListener('input', forwardCommittedText, true)

  return {
    claimKeyEvent,
    dispose: () => {
      postComposition.dispose()
      retainedHangulCommit.dispose()
      terminalElement.removeEventListener('input', forwardCommittedText, true)
    }
  }
}
