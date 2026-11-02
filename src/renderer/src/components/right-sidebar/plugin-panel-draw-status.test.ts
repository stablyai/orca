import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isPluginPanelDrawSettled,
  pluginGuestUrlRevision,
  pluginPanelDrawStatus,
  reportPluginPanelDraw,
  subscribePluginPanelDraw,
  type PluginPanelDrawStatus
} from './plugin-panel-draw-status'

const TAB = 'plugin:acme.todos/todos'
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

afterEach(() => reportPluginPanelDraw(TAB, null))

describe('pluginGuestUrlRevision', () => {
  it('reads the rev main stamps on guest URLs', () => {
    expect(pluginGuestUrlRevision(URL_R2)).toBe('dev-ab-2')
    expect(pluginGuestUrlRevision('orca-plugin-frame://f1/a.html?rev=sha256-1%2B2#x')).toBe(
      'sha256-1+2'
    )
    expect(pluginGuestUrlRevision('orca-plugin-frame://f1/a.html')).toBeNull()
    expect(pluginGuestUrlRevision(null)).toBeNull()
  })
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

  it('stops waiting on a panel that cannot draw', () => {
    expect(
      isPluginPanelDrawSettled(status({ drawn: false, guestUrl: null, failure: 'x' }), 'r9')
    ).toBe(true)
  })
})

describe('reportPluginPanelDraw', () => {
  it('stores the latest status and tells subscribers', () => {
    const listener = vi.fn()
    const unsubscribe = subscribePluginPanelDraw(listener)
    reportPluginPanelDraw(TAB, status())
    expect(pluginPanelDrawStatus(TAB)).toEqual(status())
    reportPluginPanelDraw(TAB, null)
    expect(pluginPanelDrawStatus(TAB)).toBeNull()
    unsubscribe()
    reportPluginPanelDraw(TAB, status())
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
