import type { ReadClipboardTextOptions } from '../../../shared/clipboard-text'

export const PRIMARY_SELECTION_MAX_LENGTH = 65_536
const PRIMARY_SELECTION_MAX_BYTES = PRIMARY_SELECTION_MAX_LENGTH * 4

const PRIMARY_SELECTION_NATIVE_PASTE_SUPPRESSION_MS = 750

let enabled = false
let primarySelectionText = ''
let nativePasteSuppressionUntil = 0

type SelectionClipboardApi = {
  readSelectionClipboardText: (options?: ReadClipboardTextOptions) => Promise<string>
  writeSelectionClipboardText: (text: string) => Promise<void>
}

function isLinuxUserAgent(userAgent: string): boolean {
  return !userAgent.includes('Mac') && !userAgent.includes('Windows') && userAgent.includes('Linux')
}

function getUserAgent(): string {
  return typeof navigator === 'undefined' ? '' : navigator.userAgent
}

function getSelectionClipboardApi(): SelectionClipboardApi | null {
  if (typeof window === 'undefined') {
    return null
  }
  const uiApi = window.api?.ui
  if (
    typeof uiApi?.readSelectionClipboardText !== 'function' ||
    typeof uiApi.writeSelectionClipboardText !== 'function'
  ) {
    return null
  }
  return uiApi
}

export function shouldUseSystemPrimarySelectionClipboard(userAgent = getUserAgent()): boolean {
  return isLinuxUserAgent(userAgent) && getSelectionClipboardApi() !== null
}

function canStorePrimarySelectionText(text: string): boolean {
  return enabled && text.length > 0 && text.length <= PRIMARY_SELECTION_MAX_LENGTH
}

export function setPrimarySelectionEnabled(nextEnabled: boolean): void {
  enabled = nextEnabled
  if (!enabled) {
    primarySelectionText = ''
    nativePasteSuppressionUntil = 0
  }
}

// Why: the integrated terminal injects the primary selection into the PTY
// itself on middle-click, so arm a short window to swallow Chromium's follow-up
// native paste event instead of forwarding text to the PTY twice. Only X11/Linux
// emits that native follow-up; arming elsewhere would swallow legitimate pastes.
export function armPrimarySelectionNativePasteSuppression(now: number = Date.now()): void {
  if (!enabled || !isLinuxUserAgent(getUserAgent())) {
    return
  }
  nativePasteSuppressionUntil = now + PRIMARY_SELECTION_NATIVE_PASTE_SUPPRESSION_MS
}

export function shouldSuppressPrimarySelectionNativePaste(now: number = Date.now()): boolean {
  return enabled && now <= nativePasteSuppressionUntil
}

export function isPrimarySelectionEnabled(): boolean {
  return enabled
}

export function getPrimarySelectionText(): string {
  return enabled ? primarySelectionText : ''
}

export function setPrimarySelectionText(text: string): boolean {
  if (!canStorePrimarySelectionText(text)) {
    return false
  }
  primarySelectionText = text
  const selectionClipboardApi = shouldUseSystemPrimarySelectionClipboard()
    ? getSelectionClipboardApi()
    : null
  if (selectionClipboardApi) {
    void selectionClipboardApi.writeSelectionClipboardText(text).catch(() => {})
    return true
  }

  return true
}

export async function readPrimarySelectionText(): Promise<string> {
  if (!enabled) {
    return ''
  }
  const selectionClipboardApi = shouldUseSystemPrimarySelectionClipboard()
    ? getSelectionClipboardApi()
    : null
  if (!selectionClipboardApi) {
    return primarySelectionText
  }
  try {
    return await selectionClipboardApi.readSelectionClipboardText({
      maxBytes: PRIMARY_SELECTION_MAX_BYTES
    })
  } catch {
    return primarySelectionText
  }
}

export function resetPrimarySelectionForTests(): void {
  enabled = false
  primarySelectionText = ''
  nativePasteSuppressionUntil = 0
}
