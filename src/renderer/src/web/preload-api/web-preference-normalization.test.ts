import { describe, expect, it } from 'vitest'
import { buildHostUiUpdates } from './web-preference-normalization'

describe('buildHostUiUpdates', () => {
  it('keeps the Workspace Multiplexer local and sends an old-host-safe active view', () => {
    expect(
      buildHostUiUpdates({
        activeView: 'multiplexer',
        workspaceMultiplexer: { slots: [], panes: [], layout: null },
        sidebarWidth: 280
      })
    ).toEqual({ activeView: 'terminal', sidebarWidth: 280 })
  })
})
