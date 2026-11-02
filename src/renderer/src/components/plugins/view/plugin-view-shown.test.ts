import { describe, expect, it } from 'vitest'
import { pluginPanelNotShownReason } from './plugin-view-shown'

const TAB = 'plugin:acme.todos/todos' as const
const shown: Parameters<typeof pluginPanelNotShownReason>[0] = {
  activeView: 'terminal',
  activeWorktreeId: 'wt-1',
  rightSidebarOpen: true,
  rightSidebarTab: TAB
}

describe('pluginPanelNotShownReason', () => {
  it('is null only while the panel is the open tab beside a workspace', () => {
    expect(pluginPanelNotShownReason(shown, TAB)).toBeNull()
    expect(pluginPanelNotShownReason({ ...shown, rightSidebarOpen: false }, TAB)).toBe(
      'the right sidebar is closed'
    )
    expect(pluginPanelNotShownReason({ ...shown, rightSidebarTab: 'explorer' }, TAB)).toBe(
      'the right sidebar shows another tab'
    )
    expect(pluginPanelNotShownReason({ ...shown, activeView: 'settings' }, TAB)).toBe(
      'Orca is not showing a workspace'
    )
    expect(pluginPanelNotShownReason({ ...shown, activeWorktreeId: null }, TAB)).toBe(
      'Orca is not showing a workspace'
    )
  })
})
