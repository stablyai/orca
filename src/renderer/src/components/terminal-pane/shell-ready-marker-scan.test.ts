import { describe, expect, it } from 'vitest'
import { createShellReadyMarkerScanState, scanForShellReadyMarker } from './shell-ready-marker-scan'

describe('scanForShellReadyMarker', () => {
  it('strips the marker and preserves surrounding output', () => {
    const state = createShellReadyMarkerScanState()

    expect(scanForShellReadyMarker(state, 'before \x1b]777;orca-shell-ready\x07 after')).toEqual({
      output: 'before  after',
      matched: true
    })
  })

  it('matches markers split across chunks', () => {
    const state = createShellReadyMarkerScanState()

    expect(scanForShellReadyMarker(state, 'before \x1b]777;orca')).toEqual({
      output: 'before ',
      matched: false
    })
    expect(scanForShellReadyMarker(state, '-shell-ready\x07 after')).toEqual({
      output: ' after',
      matched: true
    })
  })
})
