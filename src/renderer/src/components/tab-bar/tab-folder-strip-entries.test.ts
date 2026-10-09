import { describe, expect, it } from 'vitest'
import type { Tab } from '../../../../shared/tab-types'
import type { TabFolderGroup } from '../../../../shared/tab-folder-types'
import type { TabBarItem } from './tab-bar-item-model'
import { projectTabStripEntries, tabStripEntriesLayoutKey } from './tab-folder-strip-entries'

function makeTab(id: string, folderGroupId?: string | null): Tab {
  return {
    id,
    entityId: id,
    groupId: 'split-1',
    worktreeId: 'wt-1',
    contentType: 'terminal',
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...(folderGroupId !== undefined ? { folderGroupId } : {})
  }
}

function makeItem(id: string): TabBarItem {
  return {
    type: 'simulator',
    id,
    unifiedTabId: id,
    isPinned: false,
    data: makeTab(id)
  }
}

function makeFolder(collapsed: boolean): TabFolderGroup {
  return {
    id: 'folder-1',
    worktreeId: 'wt-1',
    splitGroupId: 'split-1',
    name: 'Review',
    color: '#3b82f6',
    collapsed,
    tabOrder: ['tab-1', 'tab-2'],
    sortOrder: 0,
    createdAt: 1
  }
}

describe('projectTabStripEntries', () => {
  it('collapses member tabs into a labeled folder chip', () => {
    const entries = projectTabStripEntries(
      [makeItem('tab-1'), makeItem('tab-2'), makeItem('tab-3')],
      [makeFolder(true)],
      [makeTab('tab-1', 'folder-1'), makeTab('tab-2', 'folder-1'), makeTab('tab-3')],
      'split-1'
    )

    expect(entries.map((entry) => entry.type)).toEqual(['folder', 'tab'])
    expect(entries[0]).toMatchObject({
      type: 'folder',
      folder: { id: 'folder-1' },
      members: [{ id: 'tab-1' }, { id: 'tab-2' }]
    })
    expect(entries[1]).toMatchObject({ type: 'tab', item: { id: 'tab-3' } })
  })

  it('expands a folder to show the chip plus member tabs', () => {
    const entries = projectTabStripEntries(
      [makeItem('tab-1'), makeItem('tab-2')],
      [makeFolder(false)],
      [makeTab('tab-1', 'folder-1'), makeTab('tab-2', 'folder-1')],
      'split-1'
    )

    expect(
      entries.map((entry) => (entry.type === 'tab' ? entry.item.id : entry.folder.id))
    ).toEqual(['folder-1', 'tab-1', 'tab-2'])
  })

  it('changes the strip layout key when a folder expands or collapses', () => {
    const items = [makeItem('tab-1'), makeItem('tab-2'), makeItem('tab-3')]
    const tabs = [makeTab('tab-1', 'folder-1'), makeTab('tab-2', 'folder-1'), makeTab('tab-3')]
    const collapsed = projectTabStripEntries(items, [makeFolder(true)], tabs, 'split-1')
    const expanded = projectTabStripEntries(items, [makeFolder(false)], tabs, 'split-1')

    expect(collapsed).toHaveLength(2)
    expect(expanded).toHaveLength(4)
    expect(tabStripEntriesLayoutKey(collapsed)).not.toBe(tabStripEntriesLayoutKey(expanded))
  })
})
