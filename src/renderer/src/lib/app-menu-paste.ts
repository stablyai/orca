import {
  isClipboardTextTooLargeError,
  type ReadClipboardTextOptions
} from '../../../shared/clipboard-text'
import { TEXT_CONTROL_PASTE_MAX_BYTES, pasteTextIntoTextControl } from './text-control-paste'
import { createTextControlRejectedResult } from './text-control-paste-diagnostics'
import { findOwnedTextControlPasteTarget } from './text-control-paste-ownership'

export const APP_MENU_PASTE_EVENT = 'orca-app-menu-paste'

export type AppMenuPasteRequestResult =
  | { status: 'handled'; target: 'terminal' | 'text-control' }
  | {
      status: 'native-fallback'
      reason: 'no-owned-target' | 'clipboard-read-failed' | 'no-clipboard-text'
    }
  | {
      status: 'rejected'
      target: 'text-control'
      reason: 'empty' | 'target-unavailable' | 'too-large'
      redactedDiagnostic: string
    }

export type AppMenuPasteRequestDeps = {
  readClipboardText: (options?: ReadClipboardTextOptions) => Promise<string>
  performNativePaste: (options?: { mode?: 'paste' | 'paste-and-match-style' }) => void
  dispatchOwnedPasteEvent?: (mode: 'paste' | 'paste-and-match-style') => boolean
  getActiveElement?: () => Element | null
  nativePasteMode?: 'paste' | 'paste-and-match-style'
}

export function dispatchAppMenuPasteEvent(
  target: Window = window,
  mode: 'paste' | 'paste-and-match-style' = 'paste'
): boolean {
  const event = new CustomEvent(APP_MENU_PASTE_EVENT, {
    detail: mode,
    bubbles: false,
    cancelable: true
  })
  target.dispatchEvent(event)
  return event.defaultPrevented
}

function findFocusedAppMenuTextControlPasteTarget(
  activeElement: Element | null = typeof document === 'undefined' ? null : document.activeElement
): HTMLInputElement | HTMLTextAreaElement | null {
  return findOwnedTextControlPasteTarget(activeElement)
}

function createAppMenuTextControlRejectedResult({
  reason,
  redactedDiagnostic
}: {
  reason: 'empty' | 'target-unavailable' | 'too-large'
  redactedDiagnostic: string
}): AppMenuPasteRequestResult {
  return {
    status: 'rejected',
    target: 'text-control',
    reason,
    redactedDiagnostic
  }
}

function getNowMs(): number {
  return globalThis.performance?.now?.() ?? Date.now()
}

export async function handleAppMenuPasteRequest({
  readClipboardText,
  performNativePaste,
  dispatchOwnedPasteEvent = (mode) => dispatchAppMenuPasteEvent(window, mode),
  getActiveElement = () => document.activeElement,
  nativePasteMode = 'paste'
}: AppMenuPasteRequestDeps): Promise<AppMenuPasteRequestResult> {
  const startedAtMs = getNowMs()
  if (dispatchOwnedPasteEvent(nativePasteMode)) {
    return { status: 'handled', target: 'terminal' }
  }

  const target = findFocusedAppMenuTextControlPasteTarget(getActiveElement())
  if (!target) {
    performNativePaste({ mode: nativePasteMode })
    return { status: 'native-fallback', reason: 'no-owned-target' }
  }

  const nativePasteIntoResolvedTarget = (
    reason: 'clipboard-read-failed' | 'no-clipboard-text'
  ): AppMenuPasteRequestResult => {
    // After the async read, native paste could target newly focused controls instead of the resolved owner.
    if (target.ownerDocument.activeElement !== target) {
      const rejectedResult = createTextControlRejectedResult(
        'target-unavailable',
        0,
        'app-menu',
        getNowMs() - startedAtMs
      )
      return createAppMenuTextControlRejectedResult({
        reason: 'target-unavailable',
        redactedDiagnostic: rejectedResult.redactedDiagnostic
      })
    }
    performNativePaste({ mode: nativePasteMode })
    return { status: 'native-fallback', reason }
  }

  let text: string
  try {
    text = await readClipboardText({ maxBytes: TEXT_CONTROL_PASTE_MAX_BYTES })
  } catch (error) {
    if (isClipboardTextTooLargeError(error)) {
      const rejectedResult = createTextControlRejectedResult(
        'too-large',
        TEXT_CONTROL_PASTE_MAX_BYTES + 1,
        'app-menu',
        getNowMs() - startedAtMs
      )
      return createAppMenuTextControlRejectedResult({
        reason: 'too-large',
        redactedDiagnostic: rejectedResult.redactedDiagnostic
      })
    }
    return nativePasteIntoResolvedTarget('clipboard-read-failed')
  }
  // Image-only clipboards read as no text; a native paste hands the image to the control's own paste handler.
  if (!text) {
    return nativePasteIntoResolvedTarget('no-clipboard-text')
  }

  const result = await pasteTextIntoTextControl(target, text, {
    source: 'app-menu',
    canContinue: (candidate) => candidate.ownerDocument.activeElement === candidate
  })

  if (result.status === 'pasted') {
    return { status: 'handled', target: 'text-control' }
  }

  // A stale-target rejection must not fall back to native paste into another control.
  return createAppMenuTextControlRejectedResult({
    reason: result.reason,
    redactedDiagnostic: result.redactedDiagnostic
  })
}
