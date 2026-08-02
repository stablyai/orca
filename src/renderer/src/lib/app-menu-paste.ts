import {
  isClipboardTextTooLargeError,
  type ReadClipboardTextOptions
} from '../../../shared/clipboard-text'
import { TEXT_CONTROL_PASTE_MAX_BYTES, pasteTextIntoTextControl } from './text-control-paste'
import { createTextControlRejectedResult } from './text-control-paste-diagnostics'
import {
  findOwnedTextControlPasteTarget,
  shouldClaimTextControlPastePayload
} from './text-control-paste-ownership'

export const APP_MENU_PASTE_EVENT = 'orca-app-menu-paste'

export type AppMenuPasteRequestResult =
  | { status: 'handled'; target: 'terminal' | 'text-control' }
  | { status: 'native-fallback'; reason: 'no-owned-target' | 'clipboard-read-failed' }
  | {
      status: 'rejected'
      target: 'text-control'
      reason: 'empty' | 'target-unavailable' | 'too-large'
      redactedDiagnostic: string
    }

export type AppMenuPasteRequestDeps = {
  readClipboardText: (options?: ReadClipboardTextOptions) => Promise<string>
  performNativePaste: (options?: { mode?: 'paste' | 'paste-and-match-style' }) => void
  dispatchOwnedPasteEvent?: () => boolean
  getActiveElement?: () => Element | null
  nativePasteMode?: 'paste' | 'paste-and-match-style'
}

export function dispatchAppMenuPasteEvent(target: Window = window): boolean {
  const event = new CustomEvent(APP_MENU_PASTE_EVENT, {
    bubbles: false,
    cancelable: true
  })
  target.dispatchEvent(event)
  return event.defaultPrevented
}

export function findFocusedAppMenuTextControlPasteTarget(
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
  dispatchOwnedPasteEvent = dispatchAppMenuPasteEvent,
  getActiveElement = () => document.activeElement,
  nativePasteMode = 'paste'
}: AppMenuPasteRequestDeps): Promise<AppMenuPasteRequestResult> {
  const startedAtMs = getNowMs()
  if (dispatchOwnedPasteEvent()) {
    return { status: 'handled', target: 'terminal' }
  }

  const target = findFocusedAppMenuTextControlPasteTarget(getActiveElement())
  if (!target) {
    performNativePaste({ mode: nativePasteMode })
    return { status: 'native-fallback', reason: 'no-owned-target' }
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
    // Why: a native fallback after async failure would paste into whichever
    // control gained focus, not the text control Orca already resolved.
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
    return { status: 'native-fallback', reason: 'clipboard-read-failed' }
  }

  const result = await pasteTextIntoTextControl(target, text, {
    source: 'app-menu',
    canContinue: (candidate) => candidate.ownerDocument.activeElement === candidate
  })

  if (result.status === 'pasted') {
    return { status: 'handled', target: 'text-control' }
  }

  // Why: for text controls Orca has already resolved ownership. Falling back
  // to native paste after a stale-target rejection can paste into a new target.
  return createAppMenuTextControlRejectedResult({
    reason: result.reason,
    redactedDiagnostic: result.redactedDiagnostic
  })
}

export function shouldOwnAppMenuTextControlPaste(text: string): boolean {
  return shouldClaimTextControlPastePayload(text)
}
