import { describe, expect, it } from 'vitest'
import type { ActivePluginPanel } from '@/store/plugin-panels'
import { getPluginPanelActivityItems } from './plugin-panel-activity-items'

const panel: ActivePluginPanel = {
  id: 'dashboard',
  title: 'Dashboard',
  tabKey: 'plugin:orca-samples.demo/dashboard',
  pluginKey: 'orca-samples.demo',
  pluginName: 'Demo'
}

describe('getPluginPanelActivityItems', () => {
  it('projects watchdog failure into host-owned activity chrome', () => {
    expect(
      getPluginPanelActivityItems([panel], {
        'plugin:orca-samples.demo/dashboard': true
      })[0]
    ).toMatchObject({
      id: panel.tabKey,
      statusIndicator: 'failure'
    })
  })
})
