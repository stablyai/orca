// @vitest-environment happy-dom
/** Replay iPadOS 26 hardware Korean capture (#13345): 깨 → 깾 → 깨주 proves batchim migration can rewrite a held syllable. Shift-typed initials must be claimed before xterm bypass, with one final write per syllable and no DEL retractions for raw-mode TUIs. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  disposeOpenTerminals,
  loadIosDeviceTrace,
  openIosTerminal,
  pretendIosWeb,
  replayIosDeviceTrace
} from './terminal-ios-hangul-preedit-fixture'

const TRACE = loadIosDeviceTrace('ipados-hardware-2set-hangul-batchim-migration-trace.json')

function pretendRecordedDevice(): void {
  pretendIosWeb(TRACE.maxTouchPoints, TRACE.userAgent)
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
})
