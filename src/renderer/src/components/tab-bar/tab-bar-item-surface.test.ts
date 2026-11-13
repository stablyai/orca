import { isValidElement } from 'react'
import { describe, expect, it } from 'vitest'
import { makeOpenFile } from '../../store/slices/editor/types/open-file.test-fixture'
import type { TabBarItem } from './tab-bar-item-model'
import type { TabBarItemActions } from './use-tab-bar-item-actions'
import { renderTabBarItems } from './tab-bar-item-surface'

function editorItem(id: string): TabBarItem {
  return {
    type: 'editor',
    id,
    unifiedTabId: `u-${id}`,
    isPinned: false,
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

describe('renderTabBarItems', () => {
  it('counts hidden tabs for close-others/left/right when only some tabs render', () => {
    const group = ['a', 'b', 'c', 'd'].map(editorItem)
    const rows = renderTabBarItems({
      items: [group[1]!],
      groupItems: group,
      props: {
        worktreeId: 'wt',
        activeTabId: null,
        activeFileId: 'b',
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
    if (!isValidElement<RowProps>(row)) {
      throw new Error('expected one rendered row')
    }
    expect(row.props.tabCount).toBe(4)
    expect(row.props.hasTabsToLeft).toBe(true)
    expect(row.props.hasTabsToRight).toBe(true)
  })
})
