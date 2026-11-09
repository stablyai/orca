import { describe, expect, it } from 'vitest'

import { build, testContext, WS } from './workspace-layout-command.test-fixture'

let next = 0
/** The ids a window proposes for one default tab. */
function ids() {
  next += 1
  return {
    tabId: `default-tab-${next}`,
    leafId: `00000000-0000-4000-9000-${String(next).padStart(12, '0')}`
  }
}

describe('applyDefaultTabs', () => {
  it('makes nothing once a workspace’s default tabs were applied', () => {
    const ctx = testContext()
    const { model, results } = build(ctx, [
      { type: 'applyDefaultTabs', workspace: WS, tabs: [{ ...ids(), title: 'Server' }] },
      { type: 'applyDefaultTabs', workspace: WS, tabs: [{ ...ids(), title: 'Again' }] }
    ])
    expect(results[1]!.createdTabs).toEqual([])
    expect(model.workspaces[WS]!.tabs).toHaveLength(1)
  })
})
