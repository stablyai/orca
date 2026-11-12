import { isImeOwnedKeyboardEvent } from '@/lib/text-input/ime/ime-composition-keyboard-event'
import { isPlainEscapeKeyEvent } from '../keyboard/agent-interrupt-key-event'
import { AGENT_PROMPT_POST_PASTE_SUBMIT_DELAY_MS } from '../../../../../../shared/agent-launch/startup/agent-prompt-injection'

// A clipboard image uploads to a remote workspace before its path can be pasted (#41502);
// a plain Enter typed meanwhile must wait, like Enter during dictation (#40226).

function isPlainEnterKeyEvent(event: KeyboardEvent): boolean {
  return (
    event.key === 'Enter' &&
    !event.repeat &&
    !event.shiftKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey
  )
}

type TerminalInputEventTarget = {
  classList?: { contains: (name: string) => boolean }
  closest?: (selector: string) => { getAttribute: (name: string) => string | null } | null
}

function eventTargetPaneId(event: Event): number | null {
  const target = event.target as TerminalInputEventTarget | null
  // Only the pane's own terminal input: its search box and chat cover are portaled into the pane too.
  if (!target?.classList?.contains('xterm-helper-textarea') || !target.closest) {
    return null
  }
  const paneId = target.closest('.pane')?.getAttribute('data-pane-id')
  return paneId === null || paneId === undefined || paneId === '' ? null : Number(paneId)
}

export function createClipboardImagePasteEnterHold({
  getPanes
}: {
  getPanes: () => readonly { id: number; terminal: { input: (data: string) => void } }[] | undefined
}) {
  let uploadingPaneId: number | null = null
  let heldEnterPaneId: number | null = null
  let heldRun = 0

  /** Registered for the capture phase: swallow an Enter typed into the pane whose image upload is in flight. */
  const handleKeyDown = (event: KeyboardEvent): void => {
    if (isImeOwnedKeyboardEvent(event)) {
      return
    }
    if (isPlainEscapeKeyEvent(event)) {
      // Esc cancels the held Enter and flows on to the terminal untouched.
      heldEnterPaneId = null
      heldRun++
      return
    }
    if (
      uploadingPaneId !== null &&
      isPlainEnterKeyEvent(event) &&
      eventTargetPaneId(event) === uploadingPaneId
    ) {
      event.preventDefault()
      event.stopImmediatePropagation()
      heldEnterPaneId = uploadingPaneId
    }
  }

  const pressHeldEnter = (paneId: number, run: number): void => {
    globalThis.setTimeout(() => {
      if (heldEnterPaneId !== paneId || heldRun !== run) {
        return
      }
      heldEnterPaneId = null
      // Like an agent prompt paste: the TUI must see the bracketed paste end before Enter.
      getPanes()
        ?.find((pane) => pane.id === paneId)
        ?.terminal.input('\r')
    }, AGENT_PROMPT_POST_PASTE_SUBMIT_DELAY_MS)
  }

  return {
    handleKeyDown,
    noteImageUploadStart: (paneId: number): void => {
      uploadingPaneId = paneId
    },
    /** `landed` is true only when the image path's bracketed paste reached the pane. */
    settleImageUpload: (paneId: number, landed: boolean): void => {
      if (uploadingPaneId === paneId) {
        uploadingPaneId = null
      }
      if (heldEnterPaneId !== paneId) {
        return
      }
      const run = ++heldRun
      if (landed) {
        pressHeldEnter(paneId, run)
      } else {
        // A failed or rejected upload drops the Enter; the paste error is already shown.
        heldEnterPaneId = null
      }
    }
  }
}

export type ClipboardImagePasteEnterHold = ReturnType<typeof createClipboardImagePasteEnterHold>
