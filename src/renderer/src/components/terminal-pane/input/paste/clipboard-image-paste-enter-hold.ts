import { isImeOwnedKeyboardEvent } from '@/lib/text-input/ime/ime-composition-keyboard-event'
import { isPlainEscapeKeyEvent } from '../keyboard/agent-interrupt-key-event'
import { AGENT_PROMPT_POST_PASTE_SUBMIT_DELAY_MS } from '../../../../../../shared/agent-launch/startup/agent-prompt-injection'

// A clipboard image uploads to a remote workspace before its path can be pasted (#41502);
// a plain Enter typed meanwhile must wait, like Enter during dictation (#40226).

/** Identifies one image-upload operation so text-paste completions cannot settle it. */
export type ClipboardImageUploadToken = Readonly<{ paneId: number; run: number }>

type TerminalInputEventTarget = {
  classList?: { contains: (name: string) => boolean }
  closest?: (selector: string) => { getAttribute: (name: string) => string | null } | null
}

type HeldPaneTerminal = { id: number; terminal: { input: (data: string) => void } }

function eventTargetPaneId(event: Event): number | null {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: DOM EventTarget probed by shape; a wrong target fails the classList guard.
  const target = event.target as TerminalInputEventTarget | null
  // Only the pane's own terminal input: its search box and chat cover are portaled into the pane too.
  if (!target?.classList?.contains('xterm-helper-textarea') || !target.closest) {
    return null
  }
  const paneId = target.closest('.pane')?.getAttribute('data-pane-id')
  return paneId === null || paneId === undefined || paneId === '' ? null : Number(paneId)
}

function isUnmodifiedEnter(event: KeyboardEvent): boolean {
  return (
    event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey
  )
}

export function createClipboardImagePasteEnterHold({
  getPanes
}: {
  getPanes: () => readonly HeldPaneTerminal[] | undefined
}) {
  // Per pane: overlapping uploads count up, and each pane holds its own Enter.
  const uploadsByPaneId = new Map<number, { count: number; run: number }>()
  const heldEnterRunByPaneId = new Map<number, number>()
  const pendingEnterTimerByPaneId = new Map<number, ReturnType<typeof globalThis.setTimeout>>()
  let runCounter = 0

  const cancelPendingEnter = (paneId: number): void => {
    const timer = pendingEnterTimerByPaneId.get(paneId)
    if (timer !== undefined) {
      globalThis.clearTimeout(timer)
      pendingEnterTimerByPaneId.delete(paneId)
    }
  }

  const pressHeldEnter = (paneId: number, run: number): void => {
    cancelPendingEnter(paneId)
    pendingEnterTimerByPaneId.set(
      paneId,
      globalThis.setTimeout(() => {
        pendingEnterTimerByPaneId.delete(paneId)
        if (heldEnterRunByPaneId.get(paneId) !== run) {
          return
        }
        heldEnterRunByPaneId.delete(paneId)
        // Like an agent prompt paste: the TUI must see the bracketed paste end before Enter.
        getPanes()
          ?.find((pane) => pane.id === paneId)
          ?.terminal.input('\r')
      }, AGENT_PROMPT_POST_PASTE_SUBMIT_DELAY_MS)
    )
  }

  /** Registered for the capture phase: swallow an Enter typed into a pane whose image upload is in flight. */
  const handleKeyDown = (event: KeyboardEvent): void => {
    if (isImeOwnedKeyboardEvent(event)) {
      return
    }
    const paneId = eventTargetPaneId(event)
    if (paneId === null) {
      return
    }
    if (isPlainEscapeKeyEvent(event)) {
      // Esc cancels that pane's held Enter and flows on to the terminal untouched.
      cancelPendingEnter(paneId)
      heldEnterRunByPaneId.delete(paneId)
      return
    }
    if (!isUnmodifiedEnter(event) || !uploadsByPaneId.has(paneId)) {
      return
    }
    // Held or auto-repeating, every Enter of the press stays out of the terminal until the path lands.
    event.preventDefault()
    event.stopImmediatePropagation()
    if (!event.repeat) {
      heldEnterRunByPaneId.set(paneId, ++runCounter)
    }
  }

  return {
    handleKeyDown,
    noteImageUploadStart: (paneId: number): ClipboardImageUploadToken => {
      const upload = uploadsByPaneId.get(paneId)
      if (upload) {
        upload.count++
        // An Enter already scheduled for this pane waits for this upload too, not just the first.
        cancelPendingEnter(paneId)
        return { paneId, run: upload.run }
      }
      const run = ++runCounter
      uploadsByPaneId.set(paneId, { count: 1, run })
      cancelPendingEnter(paneId)
      return { paneId, run }
    },
    /** `landed` is true only when the image path's bracketed paste reached the pane. */
    settleImageUpload: (token: ClipboardImageUploadToken, landed: boolean): void => {
      const upload = uploadsByPaneId.get(token.paneId)
      if (!upload || upload.run !== token.run) {
        // A stale operation, or a paste that never started an image upload.
        return
      }
      upload.count--
      if (!landed) {
        // One failed paste in the group fails the message; cancel the Enter even if uploads remain.
        cancelPendingEnter(token.paneId)
        heldEnterRunByPaneId.delete(token.paneId)
      }
      if (upload.count > 0) {
        return
      }
      uploadsByPaneId.delete(token.paneId)
      const heldRun = heldEnterRunByPaneId.get(token.paneId)
      if (heldRun === undefined) {
        return
      }
      if (landed) {
        pressHeldEnter(token.paneId, heldRun)
      } else {
        // A failed or rejected upload drops the Enter; the paste error is already shown.
        cancelPendingEnter(token.paneId)
        heldEnterRunByPaneId.delete(token.paneId)
      }
    },
    /** Teardown: clear all state so a stale timer cannot reach a remounted pane's reused id. */
    dispose: (): void => {
      for (const timer of pendingEnterTimerByPaneId.values()) {
        globalThis.clearTimeout(timer)
      }
      pendingEnterTimerByPaneId.clear()
      uploadsByPaneId.clear()
      heldEnterRunByPaneId.clear()
    }
  }
}

export type ClipboardImagePasteEnterHold = ReturnType<typeof createClipboardImagePasteEnterHold>
