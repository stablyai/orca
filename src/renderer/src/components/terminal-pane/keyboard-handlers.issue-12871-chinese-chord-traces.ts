// Recorded IME chord traces for #12871 from the two Chinese input sources, taken inside a dev e2e
// Orca build (app commit 84517d74b268bca888a44b285627ec82ffde1361, macOS 26.5.2/25F84, darwin
// arm64) at the xterm helper textarea, with PTY-side ground-truth bytes read by a child on the
// pty. Replayed by keyboard-handlers.issue-12871-recorded-chord-traces.test.ts through the same
// rig as the other recordings. Unlike the Kotoeri and Korean families, these rows cannot be
// re-recorded from this repo: tests/e2e/terminal-macos-chord-input-pipeline-probe.spec.ts is the
// recorder and was never extended past Japanese, Korean and ABC. The Chinese cases in
// tests/e2e/terminal-macos-ime-cursor-chord-native.spec.ts drive the same gestures and assert the
// resulting line end to end, but they check the rows rather than produce them.
//
// These replace an earlier Chinese recording entirely. That one was driven with the modifier
// folded into the target key's flags, which produces no modifier press or release at all, so it
// could not see the Command release these cases turn on — and it predates that release being
// honoured. Nothing from it survives here.
//
// What the three cases establish, measured rather than assumed: Chinese behaves like Kotoeri and
// not like Korean. Both sources swallow the chord and keep composing, and the byte drains at the
// commit. The two modifiers still reach the handler by different routes, and each case pins the
// route it recorded:
//
//   - `Cmd+←` delivers no arrow keyup, at any listener position or at Chromium's own input
//     dispatch. The `Cmd` release is the gesture's only end and arrives still marked composing.
//   - `Option+←` delivers the arrow's own keyup and resolves through it.
//
// A fourth cell, Zhuyin `Option+←`, was recorded and then DELIBERATELY NOT INCLUDED. Under every
// synthesis this rig can produce it commits the composition on the chord, and a human at the same
// keyboard cannot reproduce that — the preedit block stays up for them, as it does for Pinyin and
// Kotoeri. Three timing regimes were tried (a flat 80ms with the modifier as a synthetic key
// event, then the hardware medians 190/110/160ms and 700/400/500ms with the modifier posted as a
// real flagsChanged) and all three committed on the press. Rather than freeze a recording no hand
// can reproduce, the cell is left out. Its byte order is still asserted in
// terminal-macos-ime-cursor-chord-native.spec.ts, where it holds under both behaviours — but that
// spec is hand-run behind ORCA_E2E_NATIVE_MACOS_KOREAN and no workflow sets it, so be plain about
// what that leaves: after this file, Zhuyin `Option+←` has no coverage that runs on its own.
// The raw recordings and the human cross-check behind the call are attached to stablyai/orca#12732,
// where this round was measured.
import type { RecordedChordCase } from './keyboard-handlers.issue-12871-in-app-chord-traces'

export const CHINESE_TRACE_CASES: RecordedChordCase[] = [
  {
    // cn-zhuyin-command.json. Composition view read 你好 before and after the press; captured
    // PTY line 你好\x01\n. The rows below stop at the Command release, so what is replayed is
    // the gesture alone, without the commit that follows it.
    name: 'Traditional Zhuyin, Cmd+ArrowLeft over a live 你好 preedit, ended by the Command release',
    expectCalls: ['\x01'],
    expectEmitted: ['\x01'],
    commitsAfterCapture: '你好',
    rows: [
      { t: 'keydown', key: 'Meta', code: 'MetaLeft', keyCode: 91, isComposing: true, meta: true },
      {
        t: 'keydown',
        key: 'ArrowLeft',
        code: 'ArrowLeft',
        keyCode: 229,
        isComposing: true,
        meta: true
      },
      // No arrow keyup between these two rows, exactly as in the Kotoeri recording.
      { t: 'keyup', key: 'Meta', code: 'MetaLeft', keyCode: 91, isComposing: true, meta: false }
    ]
  },
  {
    // cn-pinyin-nocand-command.json. Captured PTY line nihao\x01\n — Pinyin's Return commits the
    // letters rather than the highlighted candidate, so the committed text is ASCII while the
    // composition is unmistakably live (the view reads `ni hao`, segmented by the IME).
    //
    // The composition update between the press and the Command release is the point of keeping
    // this case alongside the Zhuyin one: the carry has to survive the IME editing its own
    // preedit mid-gesture. A recovery that disarmed on composition activity would drop the byte
    // here and still pass every other case in this file.
    name: 'Simplified Pinyin, Cmd+ArrowLeft over a live ni hao preedit updated mid-gesture',
    expectCalls: ['\x01'],
    expectEmitted: ['\x01'],
    commitsAfterCapture: 'nihao',
    rows: [
      { t: 'keydown', key: 'Meta', code: 'MetaLeft', keyCode: 91, isComposing: true, meta: true },
      {
        t: 'keydown',
        key: 'ArrowLeft',
        code: 'ArrowLeft',
        keyCode: 229,
        isComposing: true,
        meta: true
      },
      { t: 'compositionupdate', data: 'ni hao', value: 'ni hao' },
      { t: 'input', data: 'ni hao', value: 'ni hao' },
      { t: 'keyup', key: 'Meta', code: 'MetaLeft', keyCode: 91, isComposing: true, meta: false }
    ]
  },
  {
    // cn-pinyin-nocand-option.json. Captured at the boundary as nihao\x1bb. The arrow's own keyup
    // arrives here, still marked composing, and spends the carry before the Alt release can —
    // the half that already worked, pinned so it fails if it stops.
    name: 'Simplified Pinyin, Option+ArrowLeft over a live ni hao preedit, ended by the arrow keyup',
    expectCalls: ['\x1bb'],
    expectEmitted: ['\x1bb'],
    commitsAfterCapture: 'nihao',
    rows: [
      { t: 'keydown', key: 'Alt', code: 'AltLeft', keyCode: 18, isComposing: true, alt: true },
      {
        t: 'keydown',
        key: 'ArrowLeft',
        code: 'ArrowLeft',
        keyCode: 229,
        isComposing: true,
        alt: true
      },
      { t: 'compositionupdate', data: 'ni hao', value: 'ni hao' },
      { t: 'input', data: 'ni hao', value: 'ni hao' },
      {
        t: 'keyup',
        key: 'ArrowLeft',
        code: 'ArrowLeft',
        keyCode: 37,
        isComposing: true,
        alt: true
      },
      { t: 'keyup', key: 'Alt', code: 'AltLeft', keyCode: 18, isComposing: false, alt: false }
    ]
  }
]
