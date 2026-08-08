// Recorded IME chord traces for #12871, taken inside a dev e2e Orca build (app commit
// 4887d924ca81c1518481dd2d9e798b6b08e74cc8, macOS 26.5.1/25F80, darwin arm64) at the xterm
// helper textarea, driven through the real OS input methods. Replayed by
// keyboard-handlers.issue-12871-recorded-chord-traces.test.ts through the same rig as the other
// recordings. Reproduce with tests/e2e/terminal-macos-chord-input-pipeline-probe.spec.ts.
//
// What is new here is the driver: these were posted as CGEvents with the modifier as its own
// key event, the way a hand types it. System Events folds the modifier into the target key's
// flags instead, which is why no earlier recording contains a modifier press or release at all
// and why the Cmd half of the gesture looked like it had no end.
//
// With that end recorded, the two input sources separate on `Cmd` exactly as they already did on
// `Option`, and the same recordings show why the arrow's own release cannot carry the decision:
//
//   - Kotoeri swallows the chord and keeps composing. No arrow keyup is ever delivered, at any
//     listener position or at Chromium's own input dispatch. The `Cmd` release is the only
//     event that marks the gesture's end, and it still reports the composition live.
//   - Korean 2-Set commits on the chord. Its arrow keyup does arrive, after compositionend and
//     with `isComposing` false, so it spends the carry without firing and the `Cmd` release that
//     follows finds nothing armed. Two independent reasons the committing source stays silent.
import type { InAppRecordedCase } from './keyboard-handlers.issue-12871-in-app-chord-traces'

export const COMMAND_RELEASE_TRACE_CASES: InAppRecordedCase[] = [
  {
    name: 'Japanese, Cmd+ArrowLeft over a live さ preedit, ended by the Command release',
    expectCalls: ['\x01'],
    expectEmitted: ['\x01'],
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
      // No arrow keyup between these two rows. That absence is the recording's whole point.
      { t: 'keyup', key: 'Meta', code: 'MetaLeft', keyCode: 91, isComposing: true, meta: false }
    ]
  },
  {
    // The platform's unmarked replay is absent from these rows for the same reason it is absent
    // from the other in-app recordings: the app's own window-level capture consumed it above the
    // probe. So this case pins the half it can speak for, which is the half a release-keyed
    // recovery can break — that neither release fires anything on a committing input source.
    name: 'Korean 2-Set, Cmd+ArrowLeft commits the syllable and neither release fires',
    expectCalls: [],
    // xterm's own commit of the preedit, not the handler's doing — `expectCalls` staying empty
    // is what says the handler kept out of it.
    expectEmitted: ['ㄴ'],
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
      { t: 'compositionupdate', data: 'ㄴ', value: 'ㄴ' },
      { t: 'input', data: 'ㄴ', value: 'ㄴ' },
      { t: 'compositionend', data: 'ㄴ', value: 'ㄴ' },
      {
        t: 'keyup',
        key: 'ArrowLeft',
        code: 'ArrowLeft',
        keyCode: 37,
        isComposing: false,
        meta: true
      },
      { t: 'keyup', key: 'Meta', code: 'MetaLeft', keyCode: 91, isComposing: false, meta: false }
    ]
  }
]
