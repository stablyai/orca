import { describe, expect, it } from 'vitest'
import {
  activityOrderForPage,
  arrangeActivityItems,
  mergeActivityOrder,
  moveStripActivity,
  reorderActivityOrders
} from './activity-bar-arrangement'
import { getDefaultRightSidebarActivityItems } from './right-sidebar-default-activity-items'
import { getVisibleRightSidebarActivityItems } from './right-sidebar-activity-visibility'
import { translate } from '@/i18n/i18n'

describe('activity bar arrangement', () => {
  const items = [{ id: 'explorer' }, { id: 'checks' }, { id: 'plugin-a', pluginKey: 'plugin-a' }]
  it('uses default order and appends new panels after saved items', () => {
    expect(arrangeActivityItems(items, []).map((item) => item.id)).toEqual([
      'explorer',
      'checks',
      'plugin-a'
    ])
    expect(
      arrangeActivityItems(
        [...items, { id: 'plugin-b', pluginKey: 'plugin-b' }],
        ['checks', 'explorer', 'plugin-a']
      ).map((item) => item.id)
    ).toEqual(['checks', 'explorer', 'plugin-a', 'plugin-b'])
  })
  it('ignores removed and duplicate ids', () => {
    expect(
      arrangeActivityItems(items, ['removed', 'checks', 'checks']).map((item) => item.id)
    ).toEqual(['explorer', 'checks', 'plugin-a'])
  })
  it('retains unavailable slots across a reorder and restores them', () => {
    const saved = ['explorer', 'checks', 'plugin-a']
    const updated = mergeActivityOrder(saved, ['plugin-a', 'explorer'])
    expect(updated).toEqual(['plugin-a', 'checks', 'explorer'])
    expect(arrangeActivityItems(items, updated).map((item) => item.id)).toEqual([
      'plugin-a',
      'checks',
      'explorer'
    ])
  })
  it('inserts newly available built-ins before plugins', () => {
    const workspaceB = [
      { id: 'explorer' },
      { id: 'vault' },
      { id: 'checks' },
      { id: 'plugin-a', pluginKey: 'plugin-a' }
    ]
    expect(
      arrangeActivityItems(workspaceB, ['checks', 'explorer', 'plugin-a']).map((item) => item.id)
    ).toEqual(['checks', 'explorer', 'vault', 'plugin-a'])
  })
  it('keeps a plugin moved ahead of saved built-ins in place', () => {
    const items = [
      { id: 'explorer' },
      { id: 'vault' },
      { id: 'workspaces' },
      { id: 'plugin-a', pluginKey: 'plugin-a' }
    ]
    expect(
      arrangeActivityItems(items, ['plugin-a', 'explorer', 'vault']).map((item) => item.id)
    ).toEqual(['plugin-a', 'explorer', 'vault', 'workspaces'])
  })
  it('inserts a missing built-in immediately after its saved predecessor', () => {
    const defaults = [
      { id: 'explorer' },
      { id: 'workspaces' },
      { id: 'vault' },
      { id: 'plugin-a', pluginKey: 'plugin-a' }
    ]
    expect(
      arrangeActivityItems(defaults, ['explorer', 'plugin-a', 'vault']).map((item) => item.id)
    ).toEqual(['explorer', 'workspaces', 'plugin-a', 'vault'])
  })
  it.each([
    [
      ['explorer', 'plugin:test/panel', 'vault'],
      ['explorer', 'plugin:test/panel', 'vault', 'workspaces', 'pr-checks', 'source-control']
    ],
    [
      ['plugin:test/panel', 'explorer', 'vault'],
      ['plugin:test/panel', 'explorer', 'vault', 'workspaces', 'pr-checks', 'source-control']
    ]
  ])('inserts folder tabs using the production default for saved %j', (saved, expected) => {
    const defaults = getDefaultRightSidebarActivityItems({
      t: translate,
      explorerShortcut: '',
      sourceControlShortcut: '',
      checksShortcut: '',
      portsShortcut: ''
    })
    const plugin = {
      id: 'plugin:test/panel' as const,
      pluginKey: 'test',
      icon: defaults[0].icon,
      title: 'Plugin',
      shortcut: ''
    }
    const folderItems = getVisibleRightSidebarActivityItems([...defaults, plugin], {
      isFolder: true,
      isFolderWorkspace: true,
      hasSshHost: false,
      isBot: false,
      isGroupHome: false,
      hasChatWorkers: false
    })
    expect(arrangeActivityItems(folderItems, saved).map((item) => item.id)).toEqual(expected)
  })
  it('places newly available PR Checks after its saved built-in predecessor', () => {
    const defaults = getDefaultRightSidebarActivityItems({
      t: translate,
      explorerShortcut: '',
      sourceControlShortcut: '',
      checksShortcut: '',
      portsShortcut: ''
    })
    const plugin = {
      id: 'plugin:test/panel' as const,
      pluginKey: 'test',
      icon: defaults[0].icon,
      title: 'Plugin',
      shortcut: ''
    }
    const available = [
      ...defaults.filter((item) =>
        ['explorer', 'vault', 'pr-checks', 'source-control', 'checks'].includes(item.id)
      ),
      plugin
    ]
    expect(
      arrangeActivityItems(available, [
        'explorer',
        'plugin:test/panel',
        'vault',
        'source-control',
        'checks'
      ]).map((item) => item.id)
    ).toEqual(['explorer', 'plugin:test/panel', 'vault', 'pr-checks', 'source-control', 'checks'])
  })
  it('keeps bot-page tabs in their page order and lets a saved order move them', () => {
    const defaults = getDefaultRightSidebarActivityItems({
      t: translate,
      explorerShortcut: '',
      sourceControlShortcut: '',
      checksShortcut: '',
      portsShortcut: '',
      isBot: true,
      needsYou: 0,
      connectorsNeedingOwner: 0
    })
    const botItems = getVisibleRightSidebarActivityItems(defaults, {
      isFolder: true,
      isFolderWorkspace: true,
      hasSshHost: false,
      isBot: true,
      isGroupHome: false,
      hasChatWorkers: false
    })
    expect(arrangeActivityItems(botItems, []).map((item) => item.id)).toEqual([
      'bot-activity',
      'bot-connectors',
      'bot-chats',
      'explorer'
    ])
    expect(
      arrangeActivityItems(botItems, ['bot-chats', 'bot-activity', 'explorer']).map(
        (item) => item.id
      )
    ).toEqual(['bot-chats', 'bot-activity', 'bot-connectors', 'explorer'])
  })
  it('keeps workspace and bot-page orders apart in both move sequences', () => {
    const workspaceIds = ['explorer', 'checks', 'source-control', 'plugin:test/panel']
    const start: { order: string[]; botOrder: string[] } = { order: workspaceIds, botOrder: [] }
    const dragChatsFirst = reorderActivityOrders(start, true, [
      'bot-chats',
      'bot-activity',
      'bot-connectors',
      'explorer'
    ])
    expect(dragChatsFirst.order).toEqual(workspaceIds)
    expect(dragChatsFirst.botOrder).toEqual([
      'bot-chats',
      'bot-activity',
      'bot-connectors',
      'explorer'
    ])
    const moveCheckedFirst = reorderActivityOrders(dragChatsFirst, false, [
      'checks',
      'explorer',
      'source-control',
      'plugin:test/panel'
    ])
    expect(moveCheckedFirst.botOrder).toEqual([
      'bot-chats',
      'bot-activity',
      'bot-connectors',
      'explorer'
    ])
    expect(activityOrderForPage(moveCheckedFirst, false)).toEqual([
      'checks',
      'explorer',
      'source-control',
      'plugin:test/panel'
    ])
  })
  it('moves a strip tab among the strip and lists More after it, with nothing saved', () => {
    const shown = ['explorer', 'checks', 'source-control', 'ports', 'vault', 'plugin:test/panel']
    const strip = new Set(['explorer', 'checks'])
    // Move Checks left with the strip showing only Explorer and Checks.
    const moved = moveStripActivity(shown, strip, 'checks', 'explorer')
    expect(moved).toEqual([
      'checks',
      'explorer',
      'source-control',
      'ports',
      'vault',
      'plugin:test/panel'
    ])
    expect(reorderActivityOrders({ order: [], botOrder: [] }, false, moved ?? []).order).toEqual(
      moved
    )
    expect(moveStripActivity(shown, strip, 'explorer', 'explorer')).toBeNull()
    expect(moveStripActivity(shown, strip, 'vault', 'explorer')).toBeNull()
  })

  it('keeps a pinned active tab in the strip when another strip tab moves past it', () => {
    // Strip shows Explorer, Checks and the pinned Worktrees (active); Source Control, Ports, Agents sit under More.
    const shown = ['explorer', 'checks', 'source-control', 'ports', 'vault', 'workspaces']
    const strip = new Set(['explorer', 'checks', 'workspaces'])
    // Move Checks right, past the pinned tab.
    expect(moveStripActivity(shown, strip, 'checks', 'workspaces')).toEqual([
      'explorer',
      'workspaces',
      'checks',
      'source-control',
      'ports',
      'vault'
    ])
    // Drag Explorer onto the pinned tab.
    expect(moveStripActivity(shown, strip, 'explorer', 'workspaces')).toEqual([
      'checks',
      'workspaces',
      'explorer',
      'source-control',
      'ports',
      'vault'
    ])
  })
})
