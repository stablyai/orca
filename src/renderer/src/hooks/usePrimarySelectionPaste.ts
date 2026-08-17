import { useEffect } from 'react'
import { isLinuxUserAgent, isMacUserAgent } from '@/components/terminal-pane/pane-helpers'
import {
  consumePrimarySelectionNativePasteSuppression,
  readPrimarySelectionText,
  setPrimarySelectionEnabled,
  setPrimarySelectionText
} from '@/lib/primary-selection'
import {
  findEditablePrimarySelectionPasteTarget,
  pastePrimarySelectionTextIntoTarget,
  type EditablePrimarySelectionPasteTarget
} from '@/lib/primary-selection-paste'
import { readCurrentPrimarySelectionText } from '@/lib/primary-selection-capture'
import { addEventListenerOnAllDocuments } from '@/lib/aux-pane-window-registry'
import { isDocument, isElement, isInputEvent, isNode } from '@/lib/cross-realm-dom-predicates'

const PRIMARY_SELECTION_PENDING_TARGET_TTL_MS = 750

export function resolvePrimarySelectionMiddleClickPaste(
  setting: boolean | undefined,
  userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent
): boolean {
  return setting ?? isDefaultPrimarySelectionMiddleClickPasteUserAgent(userAgent)
}

export function isDefaultPrimarySelectionMiddleClickPasteUserAgent(
  userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent
): boolean {
  return isLinuxUserAgent(userAgent) || isMacUserAgent(userAgent)
}

function captureCurrentSelection(sourceDocument: Document): void {
  const text = readCurrentPrimarySelectionText(sourceDocument)
  if (text) {
    setPrimarySelectionText(text)
  }
}

function suppressEvent(event: Event): void {
  event.preventDefault()
  event.stopPropagation()
  event.stopImmediatePropagation()
}

// Why: the native follow-up paste lands in xterm's hidden helper textarea;
// scope terminal-armed suppression to that surface so unrelated document pastes
// (right-click Paste, keyboard paste into another control) are never swallowed.
function isTerminalNativePasteTarget(target: EventTarget | null): boolean {
  if (!isElement(target)) {
    return false
  }
  return target.classList.contains('xterm-helper-textarea') || target.closest('.xterm') !== null
}

function isPrimarySelectionPasteTargetCurrent(
  target: EditablePrimarySelectionPasteTarget
): boolean {
  const activeElement = target.ownerDocument.activeElement
  return (
    target.isConnected &&
    isNode(activeElement) &&
    (activeElement === target || target.contains(activeElement))
  )
}

export function usePrimarySelectionPaste(enabled: boolean): void {
  useEffect(() => {
    setPrimarySelectionEnabled(enabled)
    let pendingMiddleTarget: EditablePrimarySelectionPasteTarget | null = null
    let pendingMiddleUntil = 0

    const targetMatchesPending = (target: EventTarget | null): boolean => {
      if (!pendingMiddleTarget || !isNode(target)) {
        return false
      }
      return target === pendingMiddleTarget || pendingMiddleTarget.contains(target)
    }

    const rememberPendingTarget = (event: MouseEvent): boolean => {
      if (event.button !== 1) {
        return false
      }
      const target = findEditablePrimarySelectionPasteTarget(event.target)
      if (!target) {
        return false
      }
      pendingMiddleTarget = target
      // Why: native Linux middle-click paste emits follow-up input shortly
      // after mousedown; keep ownership only for the same gesture.
      pendingMiddleUntil = Date.now() + PRIMARY_SELECTION_PENDING_TARGET_TTL_MS
      return true
    }

    const suppressPendingPasteInput = (event: InputEvent | ClipboardEvent): void => {
      const isPasteInputEvent = !isInputEvent(event) || event.inputType === 'insertFromPaste'
      if (!isPasteInputEvent) {
        return
      }
      if (
        pendingMiddleTarget &&
        Date.now() <= pendingMiddleUntil &&
        targetMatchesPending(event.target)
      ) {
        suppressEvent(event)
        return
      }
      // Why: the integrated terminal owns its middle-click paste and cannot mark
      // a pending DOM target, so honor its armed window to swallow the follow-up
      // native paste event that xterm would otherwise forward to the PTY — but
      // only for the terminal's own surface, never unrelated document pastes.
      // Consuming leaves the window disarmed so a later real paste survives.
      if (
        isTerminalNativePasteTarget(event.target) &&
        consumePrimarySelectionNativePasteSuppression()
      ) {
        suppressEvent(event)
      }
    }

    if (!enabled) {
      if (!isLinuxUserAgent()) {
        return
      }

      const onMouseDown = (event: MouseEvent): void => {
        rememberPendingTarget(event)
      }
      const onMouseUp = (event: MouseEvent): void => {
        if (event.button === 1) {
          // Why: prevent Chromium's native Linux primary paste when disabled
          // without blocking terminal apps from receiving middle-click events.
          event.preventDefault()
        }
        pendingMiddleTarget = null
      }
      const onAuxClick = (event: MouseEvent): void => {
        if (event.button === 1) {
          // Why: match the mouseup preventer for browsers that surface auxclick.
          event.preventDefault()
        }
      }

      // Why: when users opt out on Linux, Chromium can still perform native
      // primary-selection paste unless the middle-click paste pipeline is stopped.
      const removeListeners = [
        addEventListenerOnAllDocuments('mousedown', onMouseDown as EventListener, true),
        addEventListenerOnAllDocuments(
          'beforeinput',
          suppressPendingPasteInput as EventListener,
          true
        ),
        addEventListenerOnAllDocuments('paste', suppressPendingPasteInput as EventListener, true),
        addEventListenerOnAllDocuments('mouseup', onMouseUp as EventListener, true),
        addEventListenerOnAllDocuments('auxclick', onAuxClick as EventListener, true)
      ]

      return () => {
        setPrimarySelectionEnabled(false)
        for (const removeListener of removeListeners) {
          removeListener()
        }
      }
    }

    let captureTimer: number | null = null

    let captureDocument = document
    const scheduleCapture = (event: Event): void => {
      if (isDocument(event.currentTarget)) {
        captureDocument = event.currentTarget
      }
      if (captureTimer !== null) {
        window.clearTimeout(captureTimer)
      }
      captureTimer = window.setTimeout(() => {
        captureTimer = null
        captureCurrentSelection(captureDocument)
      }, 100)
    }

    const onMouseDown = (event: MouseEvent): void => {
      rememberPendingTarget(event)
    }

    const onMouseUp = (event: MouseEvent): void => {
      if (event.button !== 1 || !pendingMiddleTarget || Date.now() > pendingMiddleUntil) {
        pendingMiddleTarget = null
        return
      }

      const target = pendingMiddleTarget
      pendingMiddleTarget = null
      suppressEvent(event)
      const point = {
        clientX: event.clientX,
        clientY: event.clientY
      }
      void readPrimarySelectionText().then((text) => {
        // Why: async primary-selection reads can resolve after focus moved;
        // do not refocus and mutate a stale middle-click target.
        if (!text || !isPrimarySelectionPasteTargetCurrent(target)) {
          return
        }
        void pastePrimarySelectionTextIntoTarget(target, text, point).catch(() => {})
      })
    }

    const onAuxClick = (event: MouseEvent): void => {
      if (event.button !== 1) {
        return
      }
      const target = findEditablePrimarySelectionPasteTarget(event.target)
      if (!target) {
        return
      }
      suppressEvent(event)
    }

    const removeListeners = [
      addEventListenerOnAllDocuments('selectionchange', scheduleCapture, false),
      addEventListenerOnAllDocuments('mouseup', scheduleCapture, true),
      addEventListenerOnAllDocuments('keyup', scheduleCapture, true),
      addEventListenerOnAllDocuments('mousedown', onMouseDown as EventListener, true),
      addEventListenerOnAllDocuments(
        'beforeinput',
        suppressPendingPasteInput as EventListener,
        true
      ),
      addEventListenerOnAllDocuments('paste', suppressPendingPasteInput as EventListener, true),
      addEventListenerOnAllDocuments('mouseup', onMouseUp as EventListener, true),
      addEventListenerOnAllDocuments('auxclick', onAuxClick as EventListener, true)
    ]

    return () => {
      setPrimarySelectionEnabled(false)
      if (captureTimer !== null) {
        window.clearTimeout(captureTimer)
      }
      for (const removeListener of removeListeners) {
        removeListener()
      }
    }
  }, [enabled])
}
