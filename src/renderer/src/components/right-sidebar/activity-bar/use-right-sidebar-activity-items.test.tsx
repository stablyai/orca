// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { publishBotGroups } from '@/lib/bot-group-catalog-snapshot'
import { useAppStore } from '@/store/index'
import { usePluginPanelsStore } from '@/store/plugins/catalog/plugin-contribution-catalog'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import type { PluginHostListEntry } from '../../../../../shared/plugins/plugin-list-entry'
import { useRightSidebarActivityItems } from './use-right-sidebar-activity-items'
import { useRightSidebarTabRouting } from './use-right-sidebar-tab-routing'

const PLUGIN_TAB = 'plugin:samples.notes/panel'

const notes: PluginHostListEntry = {
  pluginKey: 'samples.notes',
  consentFingerprint: null,
  name: 'Notes',
  version: '1.0.0',
  publisher: 'samples',
  status: 'running',
  needsReconsent: false,
  isDev: false,
  official: false,
  bundled: false,
  capabilities: [],
  commands: [],
  hasWorker: false,
  restarts: 0,
  panels: [{ id: 'panel', title: 'Notes', tabKey: PLUGIN_TAB }]
}

afterEach(cleanup)

it("opens a bot group's page on Home and labels its plugin tabs like Home", () => {
  usePluginPanelsStore.getState().setPlugins([notes])
  publishBotGroups([
    {
      id: 'group-1',
      name: 'Team',
      hostId: 'local',
      revision: 1,
      folder: 'team',
      folderWorkspaceId: 'group-home',
      createdAt: 1,
      members: [],
      replyMode: { kind: 'all' }
    }
  ])
  useAppStore.setState({
    settings: getDefaultSettings('/home/test'),
    activeWorktreeId: 'folder:group-home',
    rightSidebarOpen: true,
    rightSidebarTab: PLUGIN_TAB
  })

  const { result } = renderHook(() => {
    const items = useRightSidebarActivityItems({ rightSidebarOpen: true })
    return { items, routing: useRightSidebarTabRouting(items) }
  })

  expect(
    result.current.items.visibleItems.map((item) => [item.id, item.labeledTab === true])
  ).toEqual([
    ['bot-activity', true],
    [PLUGIN_TAB, true]
  ])
  expect(result.current.routing.effectiveTab).toBe('bot-activity')
})
