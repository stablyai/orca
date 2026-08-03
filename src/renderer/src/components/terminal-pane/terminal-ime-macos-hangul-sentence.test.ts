// @vitest-environment happy-dom
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PtyTransport } from './pty-transport'
import { installTerminalImeCompositionRoute } from './terminal-ime-composition-route'
import { installTerminalImeCompositionTracker } from './terminal-ime-composition-tracker'
import { installTerminalImeNativeTextForwarder } from './terminal-ime-native-text-forwarder'
import { shouldSuppressTerminalImeKeyboardEvent } from './xterm-bypass-policy'

// Why: the per-syllable unit tests only exercise xterm, and the native macOS
// coverage is headful-only. This drives a whole 2-Set Korean sentence through
// the pane's real IME surface — bypass policy, composition tracker, native-text
// forwarder and composition route — so a regression in syllable flushing,
// word spacing or the submitting Enter fails in ordinary CI.

const KOREAN_INPUT_SOURCE_FEATURES = {
  forwardHangulJamo: true,
  forwardAsciiPunctuation: true,
  forwardShortTextReplacements: false
}

function nextEventLoop(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0))
}

type MacKoreanTerminal = {
  emitted: string[]
  textarea: HTMLTextAreaElement
  dispose: () => void
}

function openMacKoreanTerminal(): MacKoreanTerminal {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new Terminal()
  terminal.open(container)
  const textarea = terminal.textarea
  const terminalElement = terminal.element
  if (!textarea || !terminalElement) {
    throw new Error('xterm input elements were not created')
  }

  const tracker = installTerminalImeCompositionTracker(terminalElement)
  const forwarder = installTerminalImeNativeTextForwarder({
    terminalElement,
    isComposing: tracker.isActive,
    sendInput: (data) => terminal.input(data),
    getInputSourceFeatures: () => KOREAN_INPUT_SOURCE_FEATURES
  })
  terminal.attachCustomKeyEventHandler((event) => {
    const suppressed = shouldSuppressTerminalImeKeyboardEvent(event, {
      compositionActive: tracker.isActive(),
      candidateKeyGuardActive: tracker.isCandidateKeyGuardActive(),
      pendingCandidateKeyReleaseActive: false,
      isMac: true,
      isLinux: false
    })
    return suppressed ? false : !forwarder.claimKeyEvent(event)
  })
  const transport = { getPtyId: () => 'pty-korean' } as unknown as PtyTransport
  const route = installTerminalImeCompositionRoute({
    terminalElement,
    terminal,
    capturedTransport: transport,
    getCurrentTransport: () => transport
  })

  const emitted: string[] = []
  terminal.onData((data) => emitted.push(data))
  return {
    emitted,
    textarea,
    dispose: () => {
      route.dispose()
      forwarder.dispose()
      tracker.dispose()
      terminal.dispose()
    }
  }
}

function composition(textarea: HTMLTextAreaElement, type: string, data = ''): void {
  const event = new CompositionEvent(type, { bubbles: true, data })
  Object.defineProperty(event, 'data', { value: data })
  textarea.dispatchEvent(event)
}

function inputEvent(textarea: HTMLTextAreaElement, inputType: string, data?: string): void {
  const event = new InputEvent('input', { bubbles: true, data: data ?? null, inputType })
  Object.defineProperty(event, 'composed', { value: true })
  textarea.dispatchEvent(event)
}

/** Dispatches one keyboard event and reports whether xterm consumed it. */
function key(
  textarea: HTMLTextAreaElement,
  type: 'keydown' | 'keypress' | 'keyup',
  init: { key: string; code: string; keyCode: number; isComposing?: boolean }
): boolean {
  const event = new KeyboardEvent(type, {
    bubbles: true,
    cancelable: true,
    code: init.code,
    isComposing: init.isComposing ?? false,
    key: init.key
  })
  Object.defineProperties(event, {
    charCode: { value: type === 'keypress' ? init.key.charCodeAt(0) : 0 },
    keyCode: { value: init.keyCode },
    which: { value: type === 'keypress' ? init.key.charCodeAt(0) : init.keyCode }
  })
  textarea.dispatchEvent(event)
  return event.defaultPrevented
}

/** Replays the preedit of one syllable on top of the text already committed. */
function composeSyllable(
  textarea: HTMLTextAreaElement,
  committed: string,
  preedits: readonly string[]
): void {
  textarea.value = committed
  textarea.setSelectionRange(committed.length, committed.length)
  composition(textarea, 'compositionstart')
  for (const preedit of preedits) {
    composition(textarea, 'compositionupdate', preedit)
    textarea.value = `${committed}${preedit}`
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)
    inputEvent(textarea, 'insertCompositionText', preedit)
  }
}

/** The word-separating Space: it commits the live syllable and then types itself. */
function pressSpace(textarea: HTMLTextAreaElement, committedSyllable: string, line: string): void {
  composition(textarea, 'compositionend', committedSyllable)
  if (!key(textarea, 'keydown', { key: ' ', code: 'Space', keyCode: 32 })) {
    key(textarea, 'keypress', { key: ' ', code: 'Space', keyCode: 32 })
  }
  textarea.value = line
  textarea.setSelectionRange(line.length, line.length)
  inputEvent(textarea, 'insertText', ' ')
  key(textarea, 'keyup', { key: ' ', code: 'Space', keyCode: 32 })
}

describe('macOS 2-Set Korean terminal sentence', () => {
  let harness: MacKoreanTerminal | null = null

  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D)
  })

  afterEach(() => {
    harness?.dispose()
    harness = null
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('flushes every syllable, keeps both spaces and submits on Enter', async () => {
    harness = openMacKoreanTerminal()
    const { textarea } = harness

    composeSyllable(textarea, '', ['ㅎ', '하', '한'])
    composition(textarea, 'compositionend', '한')
    composeSyllable(textarea, '한', ['ㄱ', '그', '글'])
    await nextEventLoop()
    composition(textarea, 'compositionend', '글')
    composeSyllable(textarea, '한글', ['ㅇ', '이'])
    await nextEventLoop()
    pressSpace(textarea, '이', '한글이 ')
    await nextEventLoop()

    expect(harness.emitted.join('')).toBe('한글이 ')

    composeSyllable(textarea, '한글이 ', ['ㅁ', '미', '밀'])
    // Why: the ㄹ of 밀 moves into the next syllable, so compositionend reports
    // stale preedit text and only the textarea knows 미 was committed.
    composition(textarea, 'compositionend', '밀')
    textarea.value = '한글이 미리'
    textarea.setSelectionRange(5, 5)
    composition(textarea, 'compositionstart')
    composition(textarea, 'compositionupdate', '리')
    textarea.setSelectionRange(6, 6)
    inputEvent(textarea, 'insertCompositionText', '리')
    await nextEventLoop()

    expect(harness.emitted.join('')).toBe('한글이 미')

    composition(textarea, 'compositionend', '리')
    composeSyllable(textarea, '한글이 미리', ['ㄴ', '느', '는'])
    await nextEventLoop()
    pressSpace(textarea, '는', '한글이 미리는 ')
    await nextEventLoop()

    expect(harness.emitted.join('')).toBe('한글이 미리는 ')

    composeSyllable(textarea, '한글이 미리는 ', ['ㅎ', '혀', '현'])
    composition(textarea, 'compositionend', '현')
    composeSyllable(textarea, '한글이 미리는 현', ['ㅅ', '사', '상'])
    await nextEventLoop()

    // The syllable before the live preedit is already on the wire, so the TUI
    // can redraw it instead of leaving it hidden behind the composition view.
    expect(harness.emitted.join('')).toBe('한글이 미리는 현')

    composition(textarea, 'compositionend', '상')
    if (!key(textarea, 'keydown', { key: 'Enter', code: 'Enter', keyCode: 13 })) {
      key(textarea, 'keypress', { key: '\r', code: 'Enter', keyCode: 13 })
    }
    await nextEventLoop()

    expect(harness.emitted.join('')).toBe('한글이 미리는 현상\r')
  })

  it('submits the trailing syllable when Enter commits it', async () => {
    harness = openMacKoreanTerminal()
    const { textarea } = harness

    composeSyllable(textarea, '', ['ㅅ', '사', '상'])
    // Chromium delivers the keydown while the composition is still live; the
    // pane bypasses it and the IME turns it into the commit below.
    key(textarea, 'keydown', { key: 'Enter', code: 'Enter', keyCode: 13, isComposing: true })
    composition(textarea, 'compositionend', '상')
    key(textarea, 'keypress', { key: '\r', code: 'Enter', keyCode: 13 })
    await nextEventLoop()

    expect(harness.emitted.join('')).toBe('상\r')
  })
})
