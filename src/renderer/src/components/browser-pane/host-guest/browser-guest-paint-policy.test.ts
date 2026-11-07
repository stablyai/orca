import { afterEach, describe, expect, it } from 'vitest'
import { browserPageNeedsPaintRetention } from './browser-guest-paint-retention'
import { hydrateBrowserDrivers } from '../../../lib/pane-manager/browser-mobile-driver-state'
import { hydrateBrowserRemoteViewerPages } from '../../../lib/pane-manager/browser-remote-viewer-state'
import {
  acquireBrowserAutomationVisibility,
  releaseBrowserAutomationVisibility
} from './browser-automation-visibility'

// The imperative twin, for retention decisions taken outside a render (the eviction budget).
describe('browserPageNeedsPaintRetention', () => {
  afterEach(() => {
    hydrateBrowserDrivers([])
    hydrateBrowserRemoteViewerPages([])
  })

  it('answers for each term on its own', () => {
    expect(browserPageNeedsPaintRetention('page-a')).toBe(false)

    hydrateBrowserRemoteViewerPages(['page-a'])
    expect(browserPageNeedsPaintRetention('page-a')).toBe(true)
    hydrateBrowserRemoteViewerPages([])

    hydrateBrowserDrivers([
      { browserPageId: 'page-a', driver: { kind: 'mobile', clientId: 'phone-1' } }
    ])
    expect(browserPageNeedsPaintRetention('page-a')).toBe(true)
    hydrateBrowserDrivers([])

    const token = acquireBrowserAutomationVisibility('page-a')
    expect(browserPageNeedsPaintRetention('page-a')).toBe(true)
    releaseBrowserAutomationVisibility(token)
    expect(browserPageNeedsPaintRetention('page-a')).toBe(false)
  })

  it('stays scoped to the page asked about', () => {
    hydrateBrowserRemoteViewerPages(['page-a'])
    expect(browserPageNeedsPaintRetention('page-b')).toBe(false)
  })
})
