import { describe, expect, it } from 'vitest'
import type { ActivityBarItem } from './activity-bar/activity-bar-buttons'
import { getVisibleRightSidebarActivityItems } from './activity-bar/right-sidebar-activity-visibility'
import { getPluginPanelActivityItems } from './plugin-panels/plugin-panel-activity-items'

function item(id: ActivityBarItem['id'], flags: Partial<ActivityBarItem> = {}): ActivityBarItem {
  return { id, icon: () => null, title: id, shortcut: '', ...flags }
}

const items = [
  item('explorer', { onBotPage: true }),
  item('bot-activity', { botOnly: true }),
  item('bot-connectors', { botPageOnly: true }),
  item('vault'),
  item('workspaces', { folderOnly: true }),
  item('pr-checks', { folderOnly: true }),
  item('source-control', { gitOnly: true }),
  item('ports', { sshOnly: true })
]

const ids = (visible: ActivityBarItem[]): string[] => visible.map((entry) => entry.id)

describe('getVisibleRightSidebarActivityItems', () => {
  const pluginItems = getPluginPanelActivityItems([
    {
      id: 'panel',
      title: 'Notes',
      tabKey: 'plugin:acme.notes/panel',
      pluginKey: 'acme.notes',
      pluginName: 'Notes'
    }
  ])

  it("keeps bot panels and Files before installed plugin panels on a bot's page", () => {
    expect(
      ids(
        getVisibleRightSidebarActivityItems([...items, ...pluginItems], {
          isFolder: true,
          isFolderWorkspace: true,
          hasSshHost: true,
          isBot: true
        })
      )
    ).toEqual(['bot-activity', 'bot-connectors', 'explorer', 'plugin:acme.notes/panel'])
  })

  it('hides Activity everywhere a chat has started no workers', () => {
    expect(
      ids(
        getVisibleRightSidebarActivityItems(items, {
          isFolder: true,
          isFolderWorkspace: true,
          hasSshHost: false,
          isBot: false
        })
      )
    ).toEqual(['explorer', 'vault', 'workspaces', 'pr-checks', 'source-control'])
    expect(
      ids(
        getVisibleRightSidebarActivityItems(items, {
          isFolder: false,
          isFolderWorkspace: false,
          hasSshHost: true,
          isBot: false
        })
      )
    ).toEqual(['explorer', 'vault', 'source-control', 'ports'])
  })

  it('shows Activity, not Automations, beside the usual tabs when the focused chat started workers', () => {
    expect(
      ids(
        getVisibleRightSidebarActivityItems(items, {
          isFolder: false,
          isFolderWorkspace: false,
          hasSshHost: false,
          isBot: false,
          hasChatWorkers: true
        })
      )
    ).toEqual(['explorer', 'bot-activity', 'vault', 'source-control'])
  })

  it("keeps only Items on a bot group's home", () => {
    expect(
      ids(
        getVisibleRightSidebarActivityItems(items, {
          isFolder: true,
          isFolderWorkspace: true,
          hasSshHost: false,
          isBot: false,
          isGroupHome: true
        })
      )
    ).toEqual(['bot-activity'])
  })

  it('keeps an every-page tab on bot pages and bot-group homes', () => {
    const withDashboard = [...items, item('agent-dashboard', { everyPage: true })]
    const state = { isFolder: true, isFolderWorkspace: true, hasSshHost: false }
    expect(
      ids(getVisibleRightSidebarActivityItems(withDashboard, { ...state, isBot: true }))
    ).toContain('agent-dashboard')
    expect(
      ids(
        getVisibleRightSidebarActivityItems(withDashboard, {
          ...state,
          isBot: false,
          isGroupHome: true
        })
      )
    ).toEqual(['bot-activity', 'agent-dashboard'])
  })
})
