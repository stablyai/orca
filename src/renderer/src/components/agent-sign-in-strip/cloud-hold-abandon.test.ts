import { describe, expect, it } from 'vitest'
import { shouldAbandonCloudHold } from './CloudAgentSignInStripPortals'

describe('NOACCT-MISLABEL: when a held launch is given up', () => {
  it('keeps waiting while its workspace is just off screen (pane unmounted, tab open)', () => {
    expect(shouldAbandonCloudHold({ paneConnected: false, tabOpen: true })).toBe(false)
  })

  it('gives up only once the tab itself is gone', () => {
    expect(shouldAbandonCloudHold({ paneConnected: false, tabOpen: false })).toBe(true)
  })

  it('never while the pane is on screen', () => {
    expect(shouldAbandonCloudHold({ paneConnected: true, tabOpen: false })).toBe(false)
  })
})
