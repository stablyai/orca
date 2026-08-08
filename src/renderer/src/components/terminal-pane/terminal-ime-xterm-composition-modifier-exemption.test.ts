// @vitest-environment happy-dom
// Guards the Meta entries in xterm's composition modifier exemption (our patch to
// CompositionHelper.keydown). Every event shape below was recorded on real macOS 2-Set Korean
// hardware — m4air, macOS 26.5.2, Apple M4 — not constructed from the spec; see
// `.tmp/ime-handoff/swarm-scratch/wave31-cmd-preedit/evidence/`.
//
// What the hardware showed, A/B'd against a build with the guard removed:
//   - A lone Cmd press mid-composition arrives as `keydown key="Meta" code="MetaLeft"
//     keyCode=91 isComposing=true`, and macOS keeps the marked text alive across it.
//   - Without the exemption that keydown reaches `_finalizeComposition(false)`, which drops the
//     overlay's `active` class AND commits the live syllable early. The IME then keeps composing
//     the same syllable with no `compositionstart`, so nothing ever re-arms the overlay and the
//     rest of the word is invisible.
//   - A Cmd *chord* never travels this path: while composing, Chromium reports it as keyCode 229
//     (already exempt), and the IME ends the composition itself with a real `compositionend`.
//     So exempting Meta cannot keep a composition alive across Cmd+A — only across a lone Cmd.
//
// Ghostty makes the same call independently: `flagsChanged` returns early under `hasMarkedText()`
// for every modifier including Super (macos/Sources/Ghostty/Surface View/SurfaceView_AppKit.swift).
//
// Scope, so nobody over-reads this file: the terminal PANE was never affected, because
// `shouldSuppressTerminalModifierKeyboardEvent` drops a standalone Meta keydown before xterm sees
// it — added for stale Kitty reporting, protective here by accident. That was proven on hardware:
// deleting only 'Meta' from TERMINAL_MODIFIER_KEYS is what flipped the clean arm to the broken one.
// The surfaces that did reach the teardown are the popout preview terminal, whose handler returns
// `true` for an IME-owned event, and mobile's webview, which installs no handler at all.
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function nextEventLoop(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0))
}

type Harness = {
  compositionView: HTMLElement
  textarea: HTMLTextAreaElement
  emitted: string[]
}

function openTerminal(): Harness {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new Terminal()
  terminal.open(container)
  const textarea = terminal.textarea
  if (!textarea) {
    throw new Error('xterm helper textarea was not created')
  }
  const compositionView = container.querySelector('.composition-view')
  if (!(compositionView instanceof HTMLElement)) {
    throw new Error('xterm composition view was not created')
  }
  const emitted: string[] = []
  terminal.onData((data) => emitted.push(data))
  return { compositionView, textarea, emitted }
}

function dispatchCompositionEvent(
  textarea: HTMLTextAreaElement,
  type: 'compositionstart' | 'compositionupdate',
  data = ''
): void {
  const event = new CompositionEvent(type, { bubbles: true })
  // happy-dom ignores CompositionEventInit.data, but Chromium supplies it.
  Object.defineProperty(event, 'data', { value: data })
  textarea.dispatchEvent(event)
}

function dispatchKey(
  textarea: HTMLTextAreaElement,
  type: 'keydown' | 'keyup',
  keyCode: number,
  key: string,
  code: string
): void {
  const event = new KeyboardEvent(type, { key, code, isComposing: true, bubbles: true })
  Object.defineProperty(event, 'keyCode', { value: keyCode })
  textarea.dispatchEvent(event)
}

function setValue(textarea: HTMLTextAreaElement, value: string): void {
  textarea.value = value
  textarea.selectionStart = value.length
  textarea.selectionEnd = value.length
}

/** Advance the preedit by one macOS 2-Set jamo; every such keydown is keyCode 229. */
async function typeJamo(
  { textarea }: Harness,
  preedit: string,
  code: string,
  opening = false
): Promise<void> {
  dispatchKey(textarea, 'keydown', 229, 'Process', code)
  if (opening) {
    dispatchCompositionEvent(textarea, 'compositionstart')
  }
  setValue(textarea, preedit)
  dispatchCompositionEvent(textarea, 'compositionupdate', preedit)
  await nextEventLoop()
}

/** Compose 한, leaving the preedit live and displayed. */
async function composeHan(harness: Harness): Promise<void> {
  await typeJamo(harness, 'ㅎ', 'KeyG', true)
  await typeJamo(harness, '하', 'KeyK')
  await typeJamo(harness, '한', 'KeyS')
}

/** Press and release a lone modifier while the composition is live. */
async function pressModifierMidComposition(
  harness: Harness,
  keyCode: number,
  key: string,
  code: string
): Promise<void> {
  dispatchKey(harness.textarea, 'keydown', keyCode, key, code)
  await nextEventLoop()
  dispatchKey(harness.textarea, 'keyup', keyCode, key, code)
  await nextEventLoop()
}

const EXEMPT_MODIFIERS: [string, number, string, string][] = [
  ['Shift', 16, 'Shift', 'ShiftLeft'],
  ['Ctrl', 17, 'Control', 'ControlLeft'],
  ['Alt', 18, 'Alt', 'AltLeft'],
  ['left Cmd', 91, 'Meta', 'MetaLeft'],
  ['right Cmd', 93, 'Meta', 'MetaRight'],
  ['Firefox Meta', 224, 'Meta', 'MetaLeft']
]

describe('xterm composition modifier exemption', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it.each(EXEMPT_MODIFIERS)(
    'a lone %s keeps the preedit displayed and uncommitted',
    async (_label, keyCode, key, code) => {
      const harness = await openTerminal()
      await composeHan(harness)
      // Precondition: without it, "still active" below would be vacuous.
      expect(harness.compositionView.classList.contains('active')).toBe(true)

      await pressModifierMidComposition(harness, keyCode, key, code)
      expect(harness.compositionView.classList.contains('active')).toBe(true)
      // The IME still owns the syllable, so nothing may reach the PTY yet.
      expect(harness.emitted).toEqual([])

      // Recorded on hardware: composition continues with no further compositionstart, so an
      // overlay dropped by the modifier would never come back.
      await typeJamo(harness, '한ㄱ', 'KeyR')
      expect(harness.compositionView.textContent).toContain('한ㄱ')
      expect(harness.compositionView.classList.contains('active')).toBe(true)
      expect(harness.emitted).toEqual([])
    }
  )

  it('ordinary negative: Enter still finalizes the composition immediately', async () => {
    const harness = await openTerminal()
    await composeHan(harness)
    expect(harness.compositionView.classList.contains('active')).toBe(true)

    dispatchKey(harness.textarea, 'keydown', 13, 'Enter', 'Enter')
    await nextEventLoop()

    // This is the case the immediate-finalize branch exists for, so the ordering is the
    // assertion: the composition must reach the PTY before the carriage return does.
    expect(harness.compositionView.classList.contains('active')).toBe(false)
    expect(harness.emitted).toEqual(['한', '\r'])
  })
})
