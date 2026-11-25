type TerminalNativeOnlyShortcutKeyEvent = {
  key: string
  code?: string
  repeat?: boolean
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

/** Normalize physical identity so keypress with no code still pairs with Space keydown. */
export function getTerminalShortcutKeyIdentity(event: TerminalNativeOnlyShortcutKeyEvent): string {
  const code = event.code?.trim()
  if (code) {
    return code
  }
  // Bare Space must match the code-based identity used at keydown.
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
  // Either normalized alias can pair code-less keypress with Space keydown.
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
    // Input-source changes can commit IME text before release; cancel only this native chord’s printable text.
    for (const key of pendingKeys.values()) {
      if (getExpectedText(key) === event.data) {
        return true
      }
    }
    return false
  }

  return {
    prepareKeyDown: (event) => {
      // Replace only this key’s lost-release entry so rollover preserves other held native chords.
      if (!event.repeat) {
        pendingKeys.delete(getTerminalShortcutKeyIdentity(event))
      }
    },
    armKeyDown: (event) => {
      pendingKeys.set(getTerminalShortcutKeyIdentity(event), event.key)
    },
    consumeCompanion: (event) => consumeCompanion(event, pendingKeys),
    shouldSuppressBeforeInput,
    clear: () => pendingKeys.clear()
  }
}
