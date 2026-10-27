import { describe, expect, it } from 'vitest'
import {
  STATUS_BAR_DENSITY_LEVELS,
  pickStatusBarDensityLevel,
  recordStatusBarDensityWidth
} from './status-bar-density'

const TIGHTEST = STATUS_BAR_DENSITY_LEVELS.length - 1
const w = (natural: number, fit = natural) => ({ natural, fit })

describe('recordStatusBarDensityWidth', () => {
  it('forgets other levels when a level re-measures differently', () => {
    expect(recordStatusBarDensityWidth([w(700), w(600), w(500)], 1, w(640))).toEqual([
      undefined,
      w(640)
    ])
  })

  it('drops only the other collapsing levels when only the collapsed width moves', () => {
    // Urgency changes which chips collapse, moving fit widths but never the natural one.
    expect(
      recordStatusBarDensityWidth(
        [w(700), w(600), w(500), w(600, 450), w(500, 400)],
        3,
        w(600, 430)
      )
    ).toEqual([w(700), w(600), w(500), w(600, 430), undefined])
  })

  it('re-probes a roomier collapsing level once the tightest level sees its fit move', () => {
    // Level 3's stale fit (450) kept the bar at level 4; fewer urgent chips now let it fit.
    const settled = [w(700), w(600), w(500), w(600, 450), w(500, 400)]
    expect(pickStatusBarDensityLevel(settled, 420)).toBe(TIGHTEST)
    const remeasured = recordStatusBarDensityWidth(settled, TIGHTEST, w(500, 380))
    expect(remeasured).toEqual([w(700), w(600), w(500), undefined, w(500, 380)])
    expect(pickStatusBarDensityLevel(remeasured, 420)).toBe(3)
    const probed = recordStatusBarDensityWidth(remeasured, 3, w(600, 410))
    expect(pickStatusBarDensityLevel(probed, 420)).toBe(3)
  })
})
