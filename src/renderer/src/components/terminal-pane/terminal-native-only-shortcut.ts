type TerminalNativeOnlyShortcutKeyEvent = {
  key: string
  code?: string
}

type TerminalNativeOnlyShortcutCompanionEvent = TerminalNativeOnlyShortcutKeyEvent & {
  type: string
}

type TerminalNativeOnlyShortcutBeforeInputEvent = {
  data: string | null
  inputType: string
  isComposing: boolean
}

export type TerminalNativeOnlyShortcutTracker = {
  prepareKeyDown: (event: TerminalNativeOnlyShortcutKeyEvent) => void
  armKeyDown: (event: TerminalNativeOnlyShortcutKeyEvent) => void
  consumeCompanion: (event: TerminalNativeOnlyShortcutCompanionEvent) => boolean
  shouldSuppressBeforeInput: (event: TerminalNativeOnlyShortcutBeforeInputEvent) => boolean
  clear: () => void
}

/**
 * Physical-key identity for pairing a native-only keydown with its keypress/keyup.
 * Why: Chromium keypress can omit `code` and report only `key: " "`; normalize so
 * keydown (`code: "Space"`) still matches the companion events.
 */
export function getTerminalShortcutKeyIdentity(event: TerminalNativeOnlyShortcutKeyEvent): string {
  const code = event.code?.trim()
  if (code) {
    return code
  }
  // Why: Space is the reported input-source chord; bare " " must not diverge
  // from code-based identities used on keydown.
  if (event.key === ' ' || event.key === 'Spacebar' || event.key === 'Space') {
    return 'Space'
  }
  return event.key
}

function getCompanionKeyCandidates(event: TerminalNativeOnlyShortcutKeyEvent): Set<string> {
  const candidates = new Set<string>([getTerminalShortcutKeyIdentity(event)])
  if (event.code?.trim()) {
    candidates.add(event.code.trim())
  }
  if (event.key === ' ' || event.key === 'Spacebar' || event.key === 'Space') {
    candidates.add('Space')
  }
  return candidates
}

function consumeCompanion(
  event: TerminalNativeOnlyShortcutCompanionEvent,
  pendingKeys: Map<string, string>
): boolean {
  if (event.type !== 'keypress' && event.type !== 'keyup') {
    return false
  }
  // Why: match either normalized identity so keypress without `code` still
  // pairs with a keydown that used `code: "Space"`.
  const candidates = getCompanionKeyCandidates(event)
  let matched: string | null = null
  for (const candidate of candidates) {
    if (pendingKeys.has(candidate)) {
      matched = candidate
      break
    }
  }
  if (!matched) {
    return false
  }
  if (event.type === 'keyup') {
    pendingKeys.delete(matched)
    // Why: drop any alias forms for the same physical key after release.
    for (const candidate of candidates) {
      pendingKeys.delete(candidate)
    }
  }
  return true
}

function getExpectedText(key: string): string | null {
  return key === 'Spacebar' || key === 'Space' ? ' ' : key.length === 1 ? key : null
}

export function createTerminalNativeOnlyShortcutTracker(): TerminalNativeOnlyShortcutTracker {
  const pendingKeys = new Map<string, string>()

  const shouldSuppressBeforeInput = (
    event: TerminalNativeOnlyShortcutBeforeInputEvent
  ): boolean => {
    if (event.inputType !== 'insertText' || event.isComposing) {
      return false
    }
    // Why: an input-source change can also commit IME text before keyup; cancel
    // only the printable text produced by a configured native-only chord.
    for (const key of pendingKeys.values()) {
      if (getExpectedText(key) === event.data) {
        return true
      }
    }
    return false
  }

  return {
    prepareKeyDown: (event) => {
      // Why: replace a lost-keyup entry for this key without disarming other
      // held native-only keys during normal key rollover.
      pendingKeys.delete(getTerminalShortcutKeyIdentity(event))
    },
    armKeyDown: (event) => {
      pendingKeys.set(getTerminalShortcutKeyIdentity(event), event.key)
    },
    consumeCompanion: (event) => consumeCompanion(event, pendingKeys),
    shouldSuppressBeforeInput,
    clear: () => pendingKeys.clear()
  }
}
