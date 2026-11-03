// @vitest-environment happy-dom
/** Replay iPadOS 26 hardware Korean capture (#13345): 깨 → 깾 → 깨주 proves batchim migration can rewrite a held syllable. Shift-typed initials must be claimed before xterm bypass, with one final write per syllable and no DEL retractions for raw-mode TUIs. */
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

      // The device produced correct text only at blur after batchim rewrite stalled the hold; require timely syllable delivery too.
      expect(TRACE.observedSent).toEqual(['한', '글', '깨쥠'])
      expect(rig.emitted).toEqual(['한', '글', '깨'])
      expect(rig.preedit.heldText()).toBe('쥠')
      expect(drift).toEqual([])
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
  })

  it('migrates a batchim with nothing committed before it', async () => {
    // Exercise batchim rewrite at line start, where no settled prefix can mask an early release.
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
