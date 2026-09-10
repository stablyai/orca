import { describe, expect, it } from 'vitest'

import {
  ODOO_TICKET_PANEL_REFRESH_INTERVAL_MS,
  shouldRunScheduledOdooRefresh
} from './odoo-ticket-panel-refresh-schedule'

describe('shouldRunScheduledOdooRefresh', () => {
  const ready = { connected: true, windowVisible: true, loading: false }

  it('reads when connected, visible and idle', () => {
    expect(shouldRunScheduledOdooRefresh(ready)).toBe(true)
  })

  it('skips while disconnected', () => {
    expect(shouldRunScheduledOdooRefresh({ ...ready, connected: false })).toBe(false)
  })

  it('skips while the window is hidden, so a background Orca costs nothing', () => {
    expect(shouldRunScheduledOdooRefresh({ ...ready, windowVisible: false })).toBe(false)
  })

  it('skips while a read is already in flight', () => {
    expect(shouldRunScheduledOdooRefresh({ ...ready, loading: true })).toBe(false)
  })
})

describe('ODOO_TICKET_PANEL_REFRESH_INTERVAL_MS', () => {
  it('stays slow enough that an SSH session is not re-reading constantly', () => {
    expect(ODOO_TICKET_PANEL_REFRESH_INTERVAL_MS).toBe(4 * 60 * 60 * 1000)
    expect(ODOO_TICKET_PANEL_REFRESH_INTERVAL_MS).toBeGreaterThanOrEqual(60 * 60 * 1000)
  })
})
