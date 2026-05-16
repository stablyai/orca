import { useEffect } from 'react'
import { isLinuxUserAgent } from '@/components/terminal-pane/pane-helpers'
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

export function resolvePrimarySelectionMiddleClickPaste(
  setting: boolean | undefined,
  userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent
): boolean {
  return setting ?? isLinuxUserAgent(userAgent)
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
      pendingMiddleUntil = Date.now() + 750
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
        if (!text) {
          return
        }
        pastePrimarySelectionTextIntoTarget(target, text, point)
      })
    }

    const onAuxClick = (event: MouseEvent): void => {
      if (event.button === 1 && findEditablePrimarySelectionPasteTarget(event.target)) {
        suppressEvent(event)
      }
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
