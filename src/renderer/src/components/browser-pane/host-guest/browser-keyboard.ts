import { forEachLivePaneForDesyncSentinel } from '@/lib/pane-manager/pane-manager-registry'
import { readTerminalClipboardSelection } from '@/components/terminal-pane/terminal-clipboard-selection-text'

type EditableTargetLike = {
  isContentEditable?: boolean
  closest?: (selector: string) => unknown
  classList?: { contains: (token: string) => boolean }
}

type TextSelectionLike = {
  isCollapsed?: boolean
  toString: () => string
}

type CopyChordEventLike = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>

type TerminalSelectionSurface = {
  hasSelection: () => boolean
  getSelection: () => string
}

// Why: browser grab repurposes the platform copy chord; a live host selection (chat
// transcript, sidebar prose) is the surface-independent signal the user is copying.
// Guest selections live in the <webview> document and never reach window.getSelection().
export function hasHostTextSelection(
  selection: TextSelectionLike | null = typeof window === 'undefined' ? null : window.getSelection()
): boolean {
  if (!selection || selection.isCollapsed === true) {
    return false
  }
  return selection.toString().trim() !== ''
}

// Why: only the platform copy chord collides with native/terminal copy. A grab binding
// rebound away from Mod/Ctrl+C must still arm while text is selected.
export function isNativeCopyChord(event: CopyChordEventLike, platform: NodeJS.Platform): boolean {
  if (event.key.toLowerCase() !== 'c' || event.altKey || event.shiftKey) {
    return false
  }
  return platform === 'darwin' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
}

// Why: xterm focuses a hidden helper textarea; shared editable-target.ts deliberately
// excludes it so app chords still fire, but grab must not steal while that surface owns keys.
export function isTerminalKeyboardTarget(target: EventTarget | EditableTargetLike | null): boolean {
  if (!target || typeof target !== 'object') {
    return false
  }
  if ('classList' in target && target.classList?.contains('xterm-helper-textarea')) {
    return true
  }
  if ('closest' in target && typeof target.closest === 'function') {
    return target.closest('.xterm') != null
  }
  return false
}

function asTerminalSelectionSurface(terminal: unknown): TerminalSelectionSurface | null {
  if (!terminal || typeof terminal !== 'object') {
    return null
  }
  if (
    !('hasSelection' in terminal) ||
    !('getSelection' in terminal) ||
    typeof terminal.hasSelection !== 'function' ||
    typeof terminal.getSelection !== 'function'
  ) {
    return null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: both members verified as functions above.
  return terminal as TerminalSelectionSurface
}

// Why: xterm selection is not a DOM Range (WebGL paints it), so window.getSelection()
// stays collapsed while a split terminal still has a copyable highlight.
export function hasLiveTerminalSelection(): boolean {
  let found = false
  forEachLivePaneForDesyncSentinel((_key, pane) => {
    if (found) {
      return
    }
    const terminal = asTerminalSelectionSurface(pane.terminal)
    if (terminal?.hasSelection()) {
      found = true
    }
  })
  return found
}

/** Copies the first live terminal selection; returns whether a write was started. */
export function copyLiveTerminalSelection(
  writeClipboardText: (text: string) => Promise<void> = (text) =>
    window.api.ui.writeTerminalClipboardText(text)
): boolean {
  let started = false
  forEachLivePaneForDesyncSentinel((_key, pane) => {
    if (started) {
      return
    }
    const terminal = asTerminalSelectionSurface(pane.terminal)
    if (!terminal?.hasSelection()) {
      return
    }
    const selection = readTerminalClipboardSelection(terminal)
    if (!selection) {
      return
    }
    started = true
    void writeClipboardText(selection).catch(() => undefined)
  })
  return started
}

/**
 * Whether the browser grab chord should yield so host/terminal copy can run.
 * Annotate and rebound grab chords are unaffected.
 */
export function shouldYieldGrabCopyChordToHostCopy(
  event: CopyChordEventLike & { target?: EventTarget | null },
  platform: NodeJS.Platform,
  options?: {
    hostSelection?: TextSelectionLike | null
    terminalHasSelection?: boolean
  }
): boolean {
  if (!isNativeCopyChord(event, platform)) {
    return false
  }
  if (isTerminalKeyboardTarget(event.target ?? null)) {
    return true
  }
  if (hasHostTextSelection(options?.hostSelection)) {
    return true
  }
  return options?.terminalHasSelection ?? hasLiveTerminalSelection()
}

export function isEditableKeyboardTarget(target: EventTarget | EditableTargetLike | null): boolean {
  const element =
    target && typeof target === 'object' && ('closest' in target || 'isContentEditable' in target)
      ? (target as EditableTargetLike)
      : null
  if (!element) {
    return false
  }

  // Why: Browser panes stay mounted beside editor splits, so their global
  // shortcut listeners must treat editor surfaces as editable too.
  const editableHost = element.closest?.(
    [
      'input',
      'textarea',
      'select',
      '[contenteditable=""]',
      '[contenteditable="true"]',
      '.monaco-editor',
      '.diff-editor',
      '.rich-markdown-editor',
      '.rich-markdown-editor-shell'
    ].join(', ')
  )
  if (editableHost) {
    return true
  }

  return element.isContentEditable === true
}
