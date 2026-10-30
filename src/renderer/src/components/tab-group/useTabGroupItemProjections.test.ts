// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { expect, it } from 'vitest'
import type { Tab } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { tabItemLabel } from '../tab-bar/tab-bar-item-label'
import { useTabGroupItemProjections } from './useTabGroupItemProjections'

const aiVaultTitle = { agent: 'claude' as const, sessionId: 'session-1', title: 'fix-tab-title' }

const unifiedTab: Tab = {
  id: 'unified-1',
  entityId: 'terminal-1',
  groupId: 'group-1',
  worktreeId: 'wt-1',
  contentType: 'terminal',
  label: 'fix-tab-title',
  generatedLabel: 'First prompt',
  aiVaultTitle,
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: 0
}

const terminalTab: TerminalTab = {
  id: 'terminal-1',
  ptyId: null,
  worktreeId: 'wt-1',
  title: 'fix-tab-title',
  generatedTitle: 'First prompt',
  aiVaultTitle,
  customTitle: null,
  color: null,
  sortOrder: 0,
  createdAt: 0
}

it('labels a terminal tab with its session title over the first-prompt title', () => {
  const { result } = renderHook(() =>
    useTabGroupItemProjections({
      groupId: 'group-1',
      worktreeId: 'wt-1',
      worktreeState: {
        groups: [
          { id: 'group-1', worktreeId: 'wt-1', activeTabId: 'unified-1', tabOrder: ['unified-1'] }
        ],
        unifiedTabs: [unifiedTab],
        terminalTabs: [terminalTab],
        openFiles: [],
        browserTabs: [],
        expandedPaneByTabId: {},
        terminalLayoutsByTabId: {},
        generatedTabTitlesEnabled: true,
        mobileEmulatorEnabled: false
      }
    })
  )
  const [projected] = result.current.terminalTabs
  expect(
    tabItemLabel(
      {
        type: 'terminal',
        id: projected.id,
        unifiedTabId: projected.unifiedTabId,
        isPinned: false,
        data: projected
      },
      true,
      null
    )
  ).toBe('fix-tab-title')
})
