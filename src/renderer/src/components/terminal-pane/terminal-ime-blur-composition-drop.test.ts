// @vitest-environment happy-dom
// HAZARD PIN — owns no reported row. Read this before treating it as a regression guard.
//
// Blurring the terminal helper textarea during a live composition silently drops the
// in-flight syllable. It never reaches onData, so it never reaches the PTY child.
// Asserted at onData, not in the DOM: the defect is in the data, not the paint.
//
// THE MECHANISM, and it is two owners deep:
//   1. CoreBrowserTerminal._handleTextAreaBlur clears the helper unconditionally —
//      `this.textarea!.value = ''` — under the comment "Text can safely be removed on
//      blur." That assumption is false while a composition is open.
//   2. CompositionHelper._finalizeComposition(true) reads the committed text back out of
//      that same value (`this._textarea.value.substring(start, end)`) from inside a
//      deferred timeout. By the time it runs, (1) has already emptied it, so the
//      substring is '' and triggerDataEvent is never reached with the syllable.
// xterm checks composition state in _syncTextArea (`|| this._compositionHelper!.isComposing`)
// and omits the same check in _handleTextAreaBlur. That asymmetry is the whole bug.
//
// WHY THIS IS REACHABLE IN ORDINARY USE — this is the point of the pin.
// releaseTerminalFocusForOutsidePointerDown blurs the composition-owning helper with no
// composition check anywhere in the chain, wired to pointerdown at TerminalPane.tsx:1895.
// Clicking outside the terminal pane mid-composition is an ordinary thing to do.
//
// FOUR THINGS A FUTURE READER MUST NOT MISREAD:
//   1. No reporter has filed this. It is NOT attributed to any row. In particular it is
//      NOT #9738: the shapes match (one syllable vanishes, surrounding committed text
//      intact — see the multi-syllable case below) but the INJECTORS do not. #9738
//      describes drops during continuous typing, with no click-away. A shape match with
//      a mismatched injector is not an owner, and this corpus has already been burned
//      once by treating "same subsystem" as "same defect".
//   2. Not an Orca-only defect, and not caused by the Orca call site. Case 3 drives a
//      bare textarea.blur() with no Orca code in the path and loses identically, so the
//      owner is upstream xterm. Orca's unguarded release is A trigger, not THE cause.
//      A fix belongs in _handleTextAreaBlur (or a composition guard before the blur),
//      not only in regular-terminal-focus-ownership.ts.
//   3. Not an event-ordering artifact. Case 2 delivers compositionend BEFORE the blur —
//      the order Chromium uses when finalizing on focus loss — and the syllable is still
//      lost, because xterm's commit read is deferred by design and lands after the clear.
//      Do not "fix" this by reordering the fixture.
//   4. Not a happy-dom artifact. Real browsers do not clear a textarea on blur; xterm
//      does it explicitly in its own handler, so this reproduces wherever that handler
//      runs. What happy-dom cannot certify is whether a real IME would additionally
//      re-deliver the text by another route — that needs hardware and is unmeasured.
//
// Measured, not inferred: every expectation was read off onData against the @xterm/xterm
// this repo installs and ships.
//   src/browser/input/CompositionHelper.ts
//     sha256 d6393a7e805139c1b8791a8996a42b7683e7bb0e03c137e98a021917605c1635
//     (patch_hash=8a8976e1ddd73b3747547f119f76a72f2fa3f8e6efc6e6134b267d9c7f80f65d;
//      re-measured after the composition-commit dedup fix, expectations unchanged)
//   src/browser/CoreBrowserTerminal.ts
//     sha256 06efd181ba938e7d3be8c49eef2e6335c9e32fc7e41ac47102a32fc4e32d8678
//   regular-terminal-focus-ownership.ts (the Orca call site under test)
//     sha256 7a1dc49be0db91fd7c09cd30b4f5ed3c9aa4e290fc177fb52fc86753c93723fe
// No fixture is read from disk: this drives the real production owner directly, so there
// is nothing to inline and nothing outside the repo to depend on.
//
// TEETH. These assertions pin CURRENT BROKEN behaviour, so they pass while the bug
// exists. The teeth are the paired no-blur control: it drives the identical composition
// without the blur and emits ['가'], which is what makes the empty expectations
// meaningful rather than vacuous. When someone guards the blur path, cases 1-4 will
// start emitting '가' and will fail — that failure is the intended signal. Update them to
// ['가'] then; do not work around them.
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { releaseTerminalFocusForOutsidePointerDown } from './regular-terminal-focus-ownership'

function openTerminal(): {
  emitted: string[]
  textarea: HTMLTextAreaElement
  container: HTMLElement
} {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new Terminal()
  terminal.open(container)
  const textarea = terminal.textarea
  if (!textarea) {
    throw new Error('xterm helper textarea was not created')
  }
  const emitted: string[] = []
  terminal.onData((data) => emitted.push(data))
  return { emitted, textarea, container }
}

function dispatchCompositionEvent(
  textarea: HTMLTextAreaElement,
  type: 'compositionstart' | 'compositionupdate' | 'compositionend',
  data = ''
): void {
  const event = new CompositionEvent(type, { bubbles: true })
  // happy-dom ignores CompositionEventInit.data, but Chromium supplies it.
  Object.defineProperty(event, 'data', { value: data })
  textarea.dispatchEvent(event)
}

function nextEventLoop(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0))
}

/** Open a composition and leave it live, with `value` staged as the preedit. */
function beginComposition(textarea: HTMLTextAreaElement, preedit: string, value = preedit): void {
  dispatchCompositionEvent(textarea, 'compositionstart')
  dispatchCompositionEvent(textarea, 'compositionupdate', preedit)
  textarea.value = value
  textarea.selectionStart = value.length
  textarea.selectionEnd = value.length
}

/** The production path: an outside pointerdown releases terminal focus. */
function releaseFocusToOutsideClick(container: HTMLElement): boolean {
  const outside = document.createElement('button')
  document.body.appendChild(outside)
  return releaseTerminalFocusForOutsidePointerDown({
    container,
    activeElement: document.activeElement,
    pointerTarget: outside,
    syncFocused: () => {}
  })
}

describe('terminal IME — blur during composition drops the syllable at onData', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('drops the composing syllable when an outside click releases terminal focus', async () => {
    const { emitted, textarea, container } = openTerminal()
    textarea.focus()
    beginComposition(textarea, '가')

    const released = releaseFocusToOutsideClick(container)
    dispatchCompositionEvent(textarea, 'compositionend', '가')
    await nextEventLoop()

    // The release fires with a composition live: nothing in the chain consults
    // composition state, which is the reachability half of this pin.
    expect(released).toBe(true)
    // CORRECT would be ['가'].
    expect(emitted).toEqual([])
  })

  it('drops it just the same when compositionend precedes the blur', async () => {
    const { emitted, textarea, container } = openTerminal()
    textarea.focus()
    beginComposition(textarea, '가')

    // Chromium finalizes the composition as it loses focus, so this is the realistic
    // order. The deferred commit read still lands after the blur cleared the value.
    dispatchCompositionEvent(textarea, 'compositionend', '가')
    releaseFocusToOutsideClick(container)
    await nextEventLoop()

    // CORRECT would be ['가'].
    expect(emitted).toEqual([])
  })

  it('drops it with no Orca code in the path, which puts the owner upstream', async () => {
    const { emitted, textarea } = openTerminal()
    textarea.focus()
    beginComposition(textarea, '가')

    textarea.blur()
    dispatchCompositionEvent(textarea, 'compositionend', '가')
    await nextEventLoop()

    // CORRECT would be ['가'].
    expect(emitted).toEqual([])
  })

  it('loses only the in-flight syllable and keeps what already committed', async () => {
    const { emitted, textarea, container } = openTerminal()
    textarea.focus()

    beginComposition(textarea, '한')
    dispatchCompositionEvent(textarea, 'compositionend', '한')
    await nextEventLoop()

    beginComposition(textarea, '가', '한가')
    releaseFocusToOutsideClick(container)
    dispatchCompositionEvent(textarea, 'compositionend', '가')
    await nextEventLoop()

    // One syllable vanishes and the surrounding text is untouched — a silent drop-one.
    // CORRECT would be ['한', '가'].
    expect(emitted).toEqual(['한'])
  })

  it('commits normally when nothing blurs, which is what gives the drops teeth', async () => {
    const { emitted, textarea } = openTerminal()
    textarea.focus()
    beginComposition(textarea, '가')

    dispatchCompositionEvent(textarea, 'compositionend', '가')
    await nextEventLoop()

    expect(emitted).toEqual(['가'])
  })

  it('leaves ordinary non-composition input alone across the same release', async () => {
    const { emitted, textarea, container } = openTerminal()
    textarea.focus()

    // A committed syllable with no composition open: the paired negative for the
    // release path, proving it is composition state and not the blur that loses data.
    beginComposition(textarea, '한')
    dispatchCompositionEvent(textarea, 'compositionend', '한')
    await nextEventLoop()

    const released = releaseFocusToOutsideClick(container)
    await nextEventLoop()

    expect(released).toBe(true)
    expect(emitted).toEqual(['한'])
  })
})
