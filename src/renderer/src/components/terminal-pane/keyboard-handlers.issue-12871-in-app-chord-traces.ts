// Recorded IME chord traces for #12871 from a SECOND, independent surface: a boundary probe at
// the xterm helper textarea of a dev e2e Orca build (app commit
// d64ccc71bd7daf7ff64fe182b9bf522b90293397, macOS 26.5.2/25F84, darwin arm64), driven through
// the real OS input methods via System Events CGEvents, with PTY-side ground-truth bytes read
// by a child on the pty. Replayed by keyboard-handlers.issue-12871-recorded-chord-traces.test.ts
// alongside the bare-page recording that lives there. Source traces (SHA-256):
//   ime-traces/korean-cmdright.json d2c12ee4828cfe8671248122f9d36875a22c020c72500eda886d7a1f04c1b790
//   ime-traces/negative-abc.json 9c9b128406381a6479256abdec8088397940d9eb436ca219660901c4205a3aa9
//
// Both cases below are NEGATIVES, and deliberately so. The bare-page recording already pins
// where the chord bytes come from; what this surface adds is the keys around them, which is
// where a release-keyed recovery can misfire — a carry that outlives its own gesture, or one
// armed from a press that had already resolved. This surface also differs from the bare-page one
// in ways the cases note inline (its window-level capture consumed unmarked chords above the
// probe, and the CGEvent driver produced no lone-modifier keydowns), so what each case can speak
// for is stated with it. Each case opens with a snapshot row restoring the textarea state the
// probe found mid-session (the leading ㄱ residue is real; the recorded composition offsets
// depend on it). A snapshot row carries only `value`, so dispatching it is a no-op for xterm.
//
// A third recording, ime-traces/japanese-overwrite-cmdleft.json (Kotoeri Romaji さ preedit,
// Cmd+ArrowLeft), is deliberately NOT replayed here. Its chord press is followed by no arrow
// keyup at all, and a window-level capture probe run on this branch found none there either, so
// replaying it could only assert that no byte is produced — which pins the #12871 defect rather
// than the fix. That recording is evidence about the platform, not a contract for this handler,
// and is raised on #12732 instead of frozen into a green assertion here.

// Structurally identical to the replaying test's own RecordedRow/RecordedCase; declared here so
// the data module stands alone and the test file keeps its types private.
export type InAppRecordedRow = {
  t: string
  key?: string
  code?: string
  keyCode?: number
  isComposing?: boolean
  meta?: boolean
  alt?: boolean
  data?: string
  inputType?: string
  value?: string
}

export type InAppRecordedCase = {
  name: string
  expectCalls: string[]
  expectEmitted: string[]
  rows: InAppRecordedRow[]
}

export const IN_APP_TRACE_CASES: InAppRecordedCase[] = [
  {
    // korean-cmdright.json dom[36..50]: committed 가나 with 나 composing, Cmd+ArrowRight.
    // Captured PTY line: 가나나\x05\x1b[C\n.
    //
    // The \x05 is absent from expectCalls because it is absent from these rows: the app's own
    // window-level capture consumed the platform's unmarked replay above the probe, so the press
    // that delivers the byte was never recorded. What survives is the half this surface can
    // speak for, and it is the half a release-keyed recovery can break — both of the pane's own
    // chances to fire on a committing input source, plus the key that follows:
    //
    //   - the marked keydown (keyCode 229, isComposing) must produce nothing;
    //   - the release must produce nothing either, because the composition has already ended by
    //     then and the platform's replay is the thing that answers;
    //   - and the PLAIN ArrowRight pressed one beat later must reach xterm as the recorded
    //     \x1b[C. This surface recorded no lone-modifier keyup, so a carry left armed past its
    //     own release would still be holding when this bare press arrives, and it matches by the
    //     same `code` — the supersede is what keeps it from answering as a stray \x05.
    name: 'Korean 2-Set, Cmd+ArrowRight, then a bare ArrowRight (in-app trace)',
    expectCalls: [],
    expectEmitted: ['나', '\u001b[C', '\r'],
    rows: [
      { t: 'input', value: 'ㄱ가나' },
      { t: 'compositionstart', data: '' },
      { t: 'compositionupdate', data: '나' },
      { t: 'input', data: '나', inputType: 'insertCompositionText', value: 'ㄱ가나나' },
      { t: 'keyup', key: 'ㅏ', code: 'KeyK', keyCode: 75, isComposing: true },
      {
        t: 'keydown',
        key: 'ArrowRight',
        code: 'ArrowRight',
        keyCode: 229,
        isComposing: true,
        meta: true
      },
      { t: 'compositionupdate', data: '나' },
      { t: 'input', data: '나', inputType: 'insertCompositionText', value: 'ㄱ가나나' },
      { t: 'compositionend', data: '나' },
      { t: 'keyup', key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, meta: true },
      { t: 'keydown', key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
      { t: 'keyup', key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
      { t: 'keydown', key: 'Enter', code: 'Enter', keyCode: 13 },
      { t: 'keyup', key: 'Enter', code: 'Enter', keyCode: 13 }
    ]
  },
  {
    // negative-abc.json dom[0..8], the recorded non-IME control the composition rulebook asks
    // for: ABC layout, not a Latin preedit — the whole capture holds no 229, no isComposing,
    // no composition event. expectEmitted equals the captured onData array verbatim, and the
    // captured PTY line is abc\x01\x1bb\n.
    //
    // The two chord KEYDOWN rows are the one reconstruction in this module: the probe sat
    // below the window capture, which consumed them (their bytes still arrived — that
    // consumption is itself the recorded proof the handler owns unmarked chords). Their fields
    // are the captured Option keyup's (dom[6]) with the type flipped, and the Cmd copy mirrors
    // it; the captured onData/PTY pin the bytes they must produce.
    //
    // Against a release-keyed recovery it is also the arming negative: no composition is live at
    // either press, so both resolve from their own keydown, and the recorded keyup that follows
    // must not send \x1bb a second time.
    name: 'ABC layout, Cmd+ArrowLeft then Option+ArrowLeft with no IME (in-app trace)',
    expectCalls: ['\u0001', '\u001bb'],
    expectEmitted: ['a', 'b', 'c', '\u0001', '\u001bb', '\r'],
    rows: [
      { t: 'keydown', key: 'a', code: 'KeyA', keyCode: 65 },
      { t: 'keyup', key: 'a', code: 'KeyA', keyCode: 65 },
      { t: 'keydown', key: 'b', code: 'KeyB', keyCode: 66 },
      { t: 'keyup', key: 'b', code: 'KeyB', keyCode: 66 },
      { t: 'keydown', key: 'c', code: 'KeyC', keyCode: 67 },
      { t: 'keyup', key: 'c', code: 'KeyC', keyCode: 67 },
      { t: 'keydown', key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37, meta: true },
      { t: 'keydown', key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37, alt: true },
      { t: 'keyup', key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37, alt: true },
      { t: 'keydown', key: 'Enter', code: 'Enter', keyCode: 13 },
      { t: 'keyup', key: 'Enter', code: 'Enter', keyCode: 13 }
    ]
  }
]
