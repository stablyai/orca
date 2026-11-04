import { describe, expect, it } from 'vitest'
import { isPluginPanelDrawSettled, type PluginPanelDrawStatus } from './plugin-panel-draw-status'
const URL_R2 =
  'orca-plugin-frame://f1/__orca/declarative-host.html?entry=src%2Fpanel.tsx&rev=dev-ab-2'

const status = (overrides: Partial<PluginPanelDrawStatus> = {}): PluginPanelDrawStatus => ({
  ui: 'components',
  guestUrl: URL_R2,
  drawn: true,
  issue: null,
  failure: null,
  ...overrides
})

describe('isPluginPanelDrawSettled', () => {
  it('waits for the guest of the asked revision to draw', () => {
    expect(isPluginPanelDrawSettled(status(), 'dev-ab-2')).toBe(true)
    // The last good tree of a replaced guest is not the current code.
    expect(isPluginPanelDrawSettled(status(), 'dev-ab-3')).toBe(false)
    expect(isPluginPanelDrawSettled(status({ drawn: false }), 'dev-ab-2')).toBe(false)
    expect(isPluginPanelDrawSettled(status(), null)).toBe(true)
    expect(isPluginPanelDrawSettled(null, null)).toBe(false)
  })
})
