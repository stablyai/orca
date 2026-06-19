import { useEffect } from 'react'
import { isLinuxUserAgent, isMacUserAgent } from '@/components/terminal-pane/pane-helpers'
import {
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

function captureCurrentSelection(): void {
  const text = readCurrentPrimarySelectionText()
  if (text) {
    setPrimarySelectionText(text)
  }
}

function suppressEvent(event: Event): void {
  event.preventDefault()
  event.stopPropagation()
  event.stopImmediatePropagation()
}

function isPrimarySelectionPasteTargetCurrent(
  target: EditablePrimarySelectionPasteTarget
): boolean {
  const activeElement = target.ownerDocument.activeElement
  return (
    target.isConnected &&
    activeElement instanceof Node &&
    (activeElement === target || target.contains(activeElement))
  )
}

export function usePrimarySelectionPaste(enabled: boolean): void {
  useEffect(() => {
    setPrimarySelectionEnabled(enabled)
    let pendingMiddleTarget: EditablePrimarySelectionPasteTarget | null = null
    let pendingMiddleUntil = 0

    const targetMatchesPending = (target: EventTarget | null): boolean => {
      if (!pendingMiddleTarget || !(target instanceof Node)) {
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
      const isPasteInputEvent =
        typeof InputEvent !== 'function' ||
        !(event instanceof InputEvent) ||
        event.inputType === 'insertFromPaste'
      if (
        pendingMiddleTarget &&
        Date.now() <= pendingMiddleUntil &&
        targetMatchesPending(event.target) &&
        isPasteInputEvent
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
      document.addEventListener('mousedown', onMouseDown, true)
      document.addEventListener('beforeinput', suppressPendingPasteInput, true)
      document.addEventListener('paste', suppressPendingPasteInput, true)
      document.addEventListener('mouseup', onMouseUp, true)
      document.addEventListener('auxclick', onAuxClick, true)

      return () => {
        setPrimarySelectionEnabled(false)
        document.removeEventListener('mousedown', onMouseDown, true)
        document.removeEventListener('beforeinput', suppressPendingPasteInput, true)
        document.removeEventListener('paste', suppressPendingPasteInput, true)
        document.removeEventListener('mouseup', onMouseUp, true)
        document.removeEventListener('auxclick', onAuxClick, true)
      }
    }

    let captureTimer: number | null = null

    const scheduleCapture = (): void => {
      if (captureTimer !== null) {
        window.clearTimeout(captureTimer)
      }
      captureTimer = window.setTimeout(() => {
        captureTimer = null
        captureCurrentSelection()
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

    document.addEventListener('selectionchange', scheduleCapture)
    document.addEventListener('mouseup', scheduleCapture, true)
    document.addEventListener('keyup', scheduleCapture, true)
    document.addEventListener('mousedown', onMouseDown, true)
    document.addEventListener('beforeinput', suppressPendingPasteInput, true)
    document.addEventListener('paste', suppressPendingPasteInput, true)
    document.addEventListener('mouseup', onMouseUp, true)
    document.addEventListener('auxclick', onAuxClick, true)

    return () => {
      setPrimarySelectionEnabled(false)
      if (captureTimer !== null) {
        window.clearTimeout(captureTimer)
      }
      document.removeEventListener('selectionchange', scheduleCapture)
      document.removeEventListener('mouseup', scheduleCapture, true)
      document.removeEventListener('keyup', scheduleCapture, true)
      document.removeEventListener('mousedown', onMouseDown, true)
      document.removeEventListener('beforeinput', suppressPendingPasteInput, true)
      document.removeEventListener('paste', suppressPendingPasteInput, true)
      document.removeEventListener('mouseup', onMouseUp, true)
      document.removeEventListener('auxclick', onAuxClick, true)
    }
  }, [enabled])
}
