import { isValidElement } from 'react'
import { describe, expect, it } from 'vitest'
import { makeOpenFile } from '../../../store/slices/editor/types/open-file.test-fixture'
import type { TabBarItem } from './tab-bar-item-model'
import type { TabBarItemActions } from './use-tab-bar-item-actions'
import { renderTabBarItems } from './tab-bar-item-surface'

function editorItem(id: string, isPinned = false): TabBarItem {
  return {
    type: 'editor',
    id,
    unifiedTabId: `u-${id}`,
    isPinned,
    data: makeOpenFile({ id, worktreeId: 'wt' })
  }
}

const noop = (): void => {}
const actions: TabBarItemActions = {
  activateTerminal: noop,
  activateFile: noop,
  activateBrowserTab: noop,
  activateAgentSession: noop,
  close: noop,
  closeFile: noop,
  closeBrowserTab: noop,
  closeOthers: noop,
  closeToRight: noop,
  closeToLeft: noop,
  closeSplitPane: noop,
  closeAllFiles: noop,
  setCustomTitle: noop,
  setTabColor: noop,
  togglePaneExpand: noop,
  duplicateBrowserTab: noop,
  makePreviewFilePermanent: noop,
  togglePinned: noop,
  toggleViewMode: noop
}

type RowProps = { tabCount: number; hasTabsToLeft: boolean; hasTabsToRight: boolean }

function renderRow(group: TabBarItem[], visibleId: string): RowProps {
  const rows = renderTabBarItems({
    items: group.filter((item) => item.id === visibleId),
    segments: [{ kind: 'tabs', start: 0, end: 1 }],
    groupItems: group,
    props: {
      worktreeId: 'wt',
      activeTabId: null,
      activeFileId: visibleId,
      activeTabType: 'editor',
      expandedPaneByTabId: {}
    },
    runtime: {
      resolvedGroupId: 'g',
      generatedTabTitlesEnabled: false,
      unifiedTabByVisibleId: new Map(),
      tabAgentTypesByTabId: {},
      nativeChatTabWideFallbackUnsafeTabsById: {},
      nativeChatTranscriptIsLocalReadable: false,
      managedBrowserCreationEnabled: false,
      statusByRelativePath: new Map()
    },
    actions,
    dropIndicatorByVisibleId: new Map(),
    includeTopTabBorder: true,
    activeClientHostedBrowserRowId: null
  })
  const row = rows[0]
  if (rows.length !== 1 || !isValidElement<RowProps>(row)) {
    throw new Error('expected one rendered row')
  }
  return row.props
}

describe('renderTabBarItems', () => {
  it('counts hidden tabs for close-others/left/right when only one tab renders', () => {
    const row = renderRow(
      ['a', 'b', 'c', 'd'].map((id) => editorItem(id)),
      'b'
    )
    // Close others is enabled while tabCount > 1.
    expect(row.tabCount).toBe(4)
    expect(row.hasTabsToLeft).toBe(true)
    expect(row.hasTabsToRight).toBe(true)
  })

  it('leaves pinned tabs out of close-others availability, since close-others keeps them', () => {
    const group = [editorItem('a', true), editorItem('b'), editorItem('c', true)]
    expect(renderRow(group, 'b').tabCount).toBe(1)
    expect(renderRow([...group, editorItem('d')], 'b').tabCount).toBe(2)
    expect(renderRow([...group, editorItem('d')], 'a').tabCount).toBe(3)
  })
})
