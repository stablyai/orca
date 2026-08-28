// @vitest-environment happy-dom
/**
 * `gksrmfRownla` → `한글깨쥠`, replayed from a capture taken on an iPad running
 * iPadOS 26 with a hardware Korean 2-set keyboard (#13345). The recording is
 * the fixture: an earlier round of this work passed against a hand-written
 * shape the device never produces, and shipped a bug the device shows in event
 * 23 of this file.
 *
 * What the device does that no reconstruction guessed — batchim migration:
 *
 *   keydown 'ㅈ' → deleteContentBackward, insertText '깾'  value '한글깾'
 *   keydown 'ㅜ' → deleteContentBackward, insertText '깨주' value '한글깨주'
 *
 * The `ㅈ` first attaches to `깨` as a final consonant, making a different
 * codepoint entirely, and only migrates forward once `ㅜ` says it starts the
 * next syllable. A syllable is not final until the following syllable's vowel
 * decides, so `깨` must not be committed when the `ㅈ` arrives.
 *
 * Two properties are pinned here:
 *
 * - `깨` opens on `ㄲ`, a Shift-typed double consonant. Orca's own Shift rule
 *   (`xterm-bypass-policy.ts`) already hides those keydowns from xterm, so a fix
 *   living inside xterm's CompositionHelper never sees them and every syllable
 *   starting with one — 깨 꿈 딸 빵 쓰다 짜다 — stays broken. Sitting upstream of
 *   the bypass policy is what makes the source of the keydown irrelevant.
 * - Nothing is sent and then retracted. A field-diffing mirror emits one write
 *   per edit and erases the superseded syllable with DEL, which raw-mode TUIs
 *   need not read as "erase one cell" and which costs a round trip each over
 *   SSH or the relay.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  deviceTraceKeystrokes,
  disposeOpenTerminals,
  dispatchKey,
  loadIosDeviceTrace,
  openIosTerminal,
  pretendIosWeb,
  replayIosDeviceTrace,
  typeJamo,
  typePrintable,
  type IosHangulRig
} from './terminal-ios-hangul-preedit-fixture'

const TRACE = loadIosDeviceTrace('ipados-hardware-2set-hangul-batchim-migration-trace.json')
const KEYSTROKES = deviceTraceKeystrokes(TRACE)

function pretendRecordedDevice(): void {
  pretendIosWeb(TRACE.maxTouchPoints, TRACE.userAgent)
}

/** The capture as keystrokes, which adds the keypress the recorder did not log. */
async function replayKeystrokes(rig: IosHangulRig, upTo = KEYSTROKES.length): Promise<void> {
  for (const step of KEYSTROKES.slice(0, upTo)) {
    await typePrintable(rig, step)
  }
}

describe('the recorded iPad device trace for 한글깨쥠', () => {
  beforeEach(() => {
    // happy-dom has no 2d context, which the DOM renderer's WidthCache requires.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D)
  })

  afterEach(() => {
    disposeOpenTerminals()
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  describe('replayed event for event, exactly as recorded', () => {
    it('commits per syllable instead of hoarding the batchim migration', async () => {
      pretendRecordedDevice()
      const rig = openIosTerminal()
      const drift = await replayIosDeviceTrace(rig, TRACE)

      // The device build reached the wire as ['한', '글', '깨쥠'] — correct text,
      // but everything from `깨` on arrived in one chunk at blur, because the
      // hold stalled the moment `깨` became `깾`.
      expect(TRACE.observedSent).toEqual(['한', '글', '깨쥠'])
      expect(rig.emitted).toEqual(['한', '글', '깨'])
      expect(rig.preedit.heldText()).toBe('쥠')
      expect(drift).toEqual([])
    })

    it('holds 깨 while the ㅈ could still belong to it', async () => {
      pretendRecordedDevice()
      const rig = openIosTerminal()
      // Up to and including the `깾` write, which is where the device build stopped.
      await replayIosDeviceTrace(rig, { ...TRACE, events: TRACE.events.slice(0, 25) })

      expect(rig.emitted).toEqual(['한', '글'])
      expect(rig.preedit.heldText()).toBe('깾')
    })

    it('reaches the PTY as 한글깨쥠', async () => {
      pretendRecordedDevice()
      const rig = openIosTerminal()
      await replayIosDeviceTrace(rig, TRACE)
      dispatchKey(rig, 'keydown', { key: 'Enter', code: 'Enter', keyCode: 13 })

      expect(rig.emitted.join('')).toBe(`${TRACE.expected}\r`)
    })

    it('puts no DEL or backspace byte on the wire', async () => {
      pretendRecordedDevice()
      const rig = openIosTerminal()
      await replayIosDeviceTrace(rig, TRACE)
      dispatchKey(rig, 'keydown', { key: 'Enter', code: 'Enter', keyCode: 13 })

      const wire = rig.emitted.join('')
      expect(wire).not.toContain('\x7f')
      expect(wire).not.toContain('\b')
      // One write per syllable plus the Enter: no retraction, and no per-edit churn.
      expect(rig.emitted).toHaveLength(5)
    })
  })

  describe('replayed as keystrokes, with the keypress a browser also fires', () => {
    it('sends the composed syllables and never the raw jamo', async () => {
      pretendRecordedDevice()
      const rig = openIosTerminal()
      await replayKeystrokes(rig)
      dispatchKey(rig, 'keydown', { key: 'Enter', code: 'Enter', keyCode: 13 })

      expect(rig.emitted.join('')).toBe(`${TRACE.expected}\r`)
      expect(rig.emitted).toEqual(['한', '글', '깨', '쥠', '\r'])
    })

    it('composes a mid-word Shift+jamo after a committed syllable', async () => {
      pretendRecordedDevice()
      const rig = openIosTerminal()
      // Through `깨`, the eighth keystroke, whose initial is a Shift-typed ㄲ.
      await replayKeystrokes(rig, 8)
      dispatchKey(rig, 'keydown', { key: 'Enter', code: 'Enter', keyCode: 13 })

      expect(rig.emitted.join('')).toBe('한글깨\r')
    })
  })

  it('composes a syllable-initial Shift+jamo with nothing before it', async () => {
    pretendRecordedDevice()
    const rig = openIosTerminal()
    await typeJamo(rig, 'ㄲ', 'ㄲ', { replaces: false, shiftKey: true })
    await typeJamo(rig, 'ㅐ', '깨', { replaces: true })
    dispatchKey(rig, 'keydown', { key: 'Enter', code: 'Enter', keyCode: 13 })

    expect(rig.emitted).toEqual(['깨', '\r'])
  })

  it('migrates a batchim with nothing committed before it', async () => {
    // The same rewrite as the trace's `깨` → `깾` → `깨주`, but opening the line:
    // the settled prefix is empty, so nothing can be released early by accident.
    pretendRecordedDevice()
    const rig = openIosTerminal()
    await typeJamo(rig, 'ㄲ', 'ㄲ', { replaces: false, shiftKey: true })
    await typeJamo(rig, 'ㅐ', '깨', { replaces: true })
    await typeJamo(rig, 'ㅈ', '깾', { replaces: true })
    expect(rig.emitted).toEqual([])

    await typeJamo(rig, 'ㅜ', '깨주', { replaces: true })
    await typeJamo(rig, 'ㅣ', '쥐', { replaces: true })

    expect(rig.emitted).toEqual(['깨'])
    expect(rig.preedit.heldText()).toBe('쥐')
  })
})
