// @vitest-environment happy-dom
// HAZARD PIN — owns no reported row. Read this before treating it as a regression guard.
//
// Two ways xterm's composition commit path corrupts the bytes the PTY child reads.
// Both are asserted at onData, not in the DOM: the defect is in the data, not the paint.
//
// 1. FIXED — the two Cmd arms below now assert the repaired contract. A non-exempt keydown
//    during a live composition reaches _finalizeComposition(false) — the IMMEDIATE branch,
//    which computes its range from a live selectionEnd and does not consult
//    _compositionSuffix at all. It commits that range at once, and nothing records what it
//    consumed, so the IME's own compositionend commits an overlapping range and the
//    syllable reaches onData TWICE. macOS Meta was the production instance, because
//    CompositionHelper.keydown exempted only 16/17/18 and 20/229 and so Cmd took this path
//    where Ctrl did not. Our patch adds 91/93/224 to that exemption set, and both arms now
//    emit the single ['한'] this file already named as correct.
//
//    ITS CAVEAT 3 BELOW IS NOW PART-MEASURED, and only part. Wave31 drove a bare Cmd into a
//    live 2-Set Korean preedit on real hardware (m4air, macOS 26.5.2, Apple M4) as a
//    CGEventType.flagsChanged — AppleScript `key code 55` posts nothing a browser can see,
//    which is why no earlier lane could reach this gesture. Chromium delivers
//    `keydown key="Meta" keyCode=91 isComposing=true`, and with the exemption removed the
//    preedit overlay went dark AND the live syllable was committed early to onData. So the
//    early commit is now observed rather than inferred. The SECOND half — a later
//    compositionend re-emitting the same range — is still inferred: that run escaped the
//    composition instead of finishing it. Evidence:
//    .tmp/ime-handoff/swarm-scratch/wave31-cmd-preedit/evidence/.
//
// 2. FIXED — the arm below now asserts the repaired contract, not a defect. An uncomposed
//    insertText landing in the window after the commit timer had already sent used to be
//    swallowed whole: _isSendingComposition stays true for one macrotask after the timer
//    cleared _pendingCompositionStart, and handleCompositionInput passed the first check,
//    then read the cleared sentinel and substituted '' for the data — unconditionally, so
//    it ate genuinely new input along with the duplicate it was aimed at.
//    handleCompositionInput now compares the payload against _sentComposition, the text
//    the deferred send actually emitted, and discards only a match.
//
//    THIS NAMED THE TRIGGER (2) PREVIOUSLY LACKED, and it is an ordinary one. Hazard (1)
//    is Cmd's; this one was left with no trigger at all, which reads as exotic. It was
//    not. A differential run through Japanese
//    multi-segment conversion found the shipped patch swallowed an ordinary Latin key
//    typed one macrotask after a conversion commit: type a segment, convert, then press
//    `a`, and the `a` was lost. No modifier, no exotic gesture — every Japanese user who
//    keeps typing straight after converting. Korean surfaced it first only because
//    2-Set composes on nearly every keystroke.
//
//    The suppression is NOT a defect on its own: it de-duplicates IMEs that deliver
//    their commit insertText a task after compositionend (IBus, Mozc), which
//    terminal-stock-composition.test.ts pins and which the fix preserves. The swallow was
//    that dedup's false positive. The two events are structurally identical — same
//    inputType, same composed, same preceding 229 keydown — and differ only in payload,
//    which is why no flag-timing change could separate them and why the fix compares
//    payloads. A flag-timing redesign was built and measured first: it fixed this and
//    duplicated on IBus, which is why it is not what landed.
//    See .tmp/ime-handoff/swarm-scratch/lane-group-e-redesign/.
//
//    CORRECTION to an earlier claim in this file that no Japanese DOM composition trace
//    exists in the corpus. One does, filed under the Linux bundles rather than the bundle
//    named for Japanese: evidence/12261-linux-x11/terminal-ime-evidence/terminal-ime-
//    evidence/terminal-ime-boundaries-does-not-suppress-repeated-legitimate-japanese-
//    conversions.json, sha256
//    c5ff8c931c4d936302e9b068de2d8a54434c558dd079328b3c616482d89e205d — 30 DOM events,
//    two にほんご->日本語 conversions, retained byte-identically in three further bundles
//    (ONE capture copied four times, not four observations). Replayed against this bundle
//    it emits 日本語日本語 under both sequencing extremes, matching its own recorded
//    onData, so repeated conversion is undisturbed and THAT much is captured.
//    It contains no post-compositionend insertText, so it cannot speak to the swallow:
//    the `a`-after-conversion figure above stays AUTHORED and unobserved.
//
// Four things a future reader must not misread:
//   1. No reporter has filed either of these. #12164 was considered and rejected —
//      CORRECTION: the grounds cited here were wrong, though the conclusion holds.
//      This said #12164's "comment 1" was output doubling and its "comment 2" was filed
//      against 1.4.163. Checked against the API: the issue has exactly two comments —
//      "I'm here right now with the same issue" and a maintainer's "should be fixed in
//      the latest v.1.4.167" — and the string 1.4.163 appears NOWHERE in the thread.
//      The real grounds are the issue BODY, whose repro is "Run any CLI agent (Codex,
//      AGY, Claude, etc.) that outputs Korean text into the Orca terminal": untyped
//      OUTPUT, no keystrokes, no composition. CompositionHelper is correctly excluded.
//      Treat that body with care — it is LLM-authored (it still contains a literal
//      "## 5. GitHub Submission Draft (Ready to Post)") and its Root Cause section
//      blames a "CJK IME preedit buffer" its own repro never engages.
//   2. Measured, not inferred: every expectation below was read off onData against the
//      @xterm/xterm this repo installs (src/browser/input/CompositionHelper.ts,
//      sha256 d6393a7e805139c1b8791a8996a42b7683e7bb0e03c137e98a021917605c1635, under
//      patch_hash=8a8976e1ddd73b3747547f119f76a72f2fa3f8e6efc6e6134b267d9c7f80f65d —
//      the store holds one directory per patch iteration, so the hash alone is ambiguous).
//      The comparison bundle is cited, NOT imported — a landed test can only exercise
//      code that ships. Stock 6.1.0-beta.287 CompositionHelper.ts,
//      sha256 1e935e66830ca171456466987cb45ed0a270553901729f11dfa91f6b702e0845
//      (sha1 ebffd1d354428143d712124f92fbcd846e6e44d4, byte-identical across beta.287,
//      .288 and .292, so this is also what VS Code 1.129.1 runs). Against that bundle
//      the duplication is version-NEUTRAL — defective on both, in different magnitudes.
//      The swallowed insertText was NOT: stock delivered the syllable and this bundle
//      dropped it, making it the one defect here that was ours rather than inherited.
//      That arm now asserts parity with stock.
//   3. Partly measured now — see the wave31 note under hazard 1. The trigger and the early
//      commit are observed on hardware; the duplicating compositionend is still inferred.
//   4. Unobserved, and the corpus cannot say more than that. Of 731 retained evidence
//      JSONs, 82 carry a keydown-bearing DOM trace; across those, all 3508 keydowns
//      during a live composition are 229 (3443) or Shift/16 (65), and none is
//      non-exempt. A further 59 bundles use a different trace shape that scan did not
//      read — they are SILENT on this branch, not supporting it. And retained captures
//      show the branch was never entered; they cannot show it is unenterable.
//      The same scan refuted an earlier premise that Space reaches this path: Space
//      during composition is keyCode 229 in every capture, and 229 returns early.
//      Do not reintroduce a Space arm.
//
// Nothing in this file pins broken behaviour any more. Both hazards are repaired and every
// arm asserts the contract, so a failure here is a regression, not a known defect.
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function nextEventLoop(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0))
}

function openTerminal(): { emitted: string[]; textarea: HTMLTextAreaElement } {
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
  return { emitted, textarea }
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

function dispatchProcessKeydown(textarea: HTMLTextAreaElement): void {
  const keydown = new KeyboardEvent('keydown', { key: 'Process', isComposing: true, bubbles: true })
  Object.defineProperty(keydown, 'keyCode', { value: 229 })
  textarea.dispatchEvent(keydown)
}

function dispatchModifierKeydown(
  textarea: HTMLTextAreaElement,
  modifier: 'Meta' | 'Control'
): void {
  const isMeta = modifier === 'Meta'
  const keydown = new KeyboardEvent('keydown', {
    key: modifier,
    code: isMeta ? 'MetaLeft' : 'ControlLeft',
    metaKey: isMeta,
    ctrlKey: !isMeta,
    bubbles: true
  })
  Object.defineProperty(keydown, 'keyCode', { value: isMeta ? 91 : 17 })
  textarea.dispatchEvent(keydown)
}

function dispatchComposedInput(textarea: HTMLTextAreaElement, init: InputEventInit): void {
  const input = new InputEvent('input', { ...init, bubbles: true })
  Object.defineProperty(input, 'composed', { value: true })
  textarea.dispatchEvent(input)
}

function setValue(textarea: HTMLTextAreaElement, value: string): void {
  textarea.value = value
  textarea.selectionStart = value.length
  textarea.selectionEnd = value.length
}

/** Walk a syllable through its preedits, leaving the composition open. */
async function preeditSyllable(textarea: HTMLTextAreaElement, steps: string[]): Promise<void> {
  for (const step of steps) {
    setValue(textarea, step)
    dispatchCompositionEvent(textarea, 'compositionupdate', step)
    dispatchComposedInput(textarea, { data: step, inputType: 'insertCompositionText' })
    await nextEventLoop()
    dispatchProcessKeydown(textarea)
  }
}

/** Compose 한, interrupted by a modifier after the first jamo. */
async function composeHanInterruptedBy(
  textarea: HTMLTextAreaElement,
  modifier: 'Meta' | 'Control'
): Promise<void> {
  dispatchProcessKeydown(textarea)
  dispatchCompositionEvent(textarea, 'compositionstart')
  await preeditSyllable(textarea, ['ㅎ'])
  dispatchModifierKeydown(textarea, modifier)
  await nextEventLoop()
  await preeditSyllable(textarea, ['하', '한'])
  dispatchCompositionEvent(textarea, 'compositionend', '한')
  await nextEventLoop()
  await nextEventLoop()
}

describe('xterm CompositionHelper — overlapping and swallowed commits at onData', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('commits the syllable once when Cmd interrupts the composition', async () => {
    const { emitted, textarea } = openTerminal()
    await composeHanInterruptedBy(textarea, 'Meta')

    // Was ['ㅎ', '한'] — the early commit emitted the bare jamo, then compositionend emitted
    // the finished syllable over the same range. Pristine beta.287 is worse still, emitting
    // ['ㅎ', '한', '한'].
    expect(emitted).toEqual(['한'])
  })

  it('commits the syllable once when Cmd arrives after the last preedit', async () => {
    const { emitted, textarea } = openTerminal()
    dispatchProcessKeydown(textarea)
    dispatchCompositionEvent(textarea, 'compositionstart')
    await preeditSyllable(textarea, ['ㅎ', '하', '한'])
    dispatchModifierKeydown(textarea, 'Meta')
    await nextEventLoop()
    dispatchCompositionEvent(textarea, 'compositionend', '한')
    await nextEventLoop()
    await nextEventLoop()

    // Was ['한', '한'], and pristine beta.287 still emits both — the defect this arm covers
    // was inherited, not ours, so the repair is ours alone.
    expect(emitted).toEqual(['한'])
  })

  it('leaves the composition intact when Ctrl interrupts in the same position', async () => {
    const { emitted, textarea } = openTerminal()
    await composeHanInterruptedBy(textarea, 'Control')

    // Paired negative: keyCode 17 is exempt, so no early commit and no overlap. The
    // difference between this arm and the first is the exemption set, nothing else.
    expect(emitted).toEqual(['한'])
  })

  it('delivers an uncomposed insertText that lands in the sending window', async () => {
    const { emitted, textarea } = openTerminal()
    dispatchProcessKeydown(textarea)
    dispatchCompositionEvent(textarea, 'compositionstart')
    await preeditSyllable(textarea, ['ㅁ', '무', '문'])
    dispatchCompositionEvent(textarea, 'compositionend', '문')
    // The commit timer has now sent 문 and cleared _pendingCompositionStart, but
    // _isSendingComposition stays true for one more macrotask.
    await nextEventLoop()
    expect(emitted).toEqual(['문'])

    const input = new InputEvent('input', { data: '제', inputType: 'insertText', bubbles: true })
    Object.defineProperty(input, 'composed', { value: false })
    textarea.dispatchEvent(input)
    await nextEventLoop()
    await nextEventLoop()

    // Was ['문'] — the whole syllable lost. '제' is not what the deferred send emitted, so
    // the dedup no longer claims it. Matches pristine beta.287; this arm, unlike the ones
    // above, was ours to fix.
    expect(emitted).toEqual(['문', '제'])
  })

  it('leaves ordinary Latin typing untouched', async () => {
    const { emitted, textarea } = openTerminal()
    for (const [key, keyCode] of [
      ['a', 65],
      ['b', 66]
    ] as [string, number][]) {
      const keydown = new KeyboardEvent('keydown', {
        key,
        code: `Key${key.toUpperCase()}`,
        bubbles: true
      })
      Object.defineProperty(keydown, 'keyCode', { value: keyCode })
      textarea.dispatchEvent(keydown)
      await nextEventLoop()
    }
    dispatchModifierKeydown(textarea, 'Meta')
    await nextEventLoop()

    // No composition, so no range to overlap and nothing for Cmd to tear down.
    expect(emitted).toEqual(['a', 'b'])
  })
})
