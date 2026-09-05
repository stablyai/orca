// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { Tab, TabGroup } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import {
  useTabGroupItemProjections,
  type TabGroupWorktreeSnapshot
} from './useTabGroupItemProjections'

describe('useTabGroupItemProjections', () => {
  it('limits terminal-only commands and ordering to visible terminal tabs', () => {
    const group: TabGroup = {
      id: 'group-a',
      worktreeId: 'worktree-a',
      activeTabId: 'editor-tab',
      tabOrder: ['terminal-tab', 'editor-tab']
    }
    const terminal: Tab = {
      id: 'terminal-tab',
      entityId: 'terminal-entity',
      groupId: group.id,
      worktreeId: group.worktreeId,
      contentType: 'terminal',
      label: 'Terminal',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: 1
    }
    const editor: Tab = {
      ...terminal,
      id: 'editor-tab',
      entityId: 'sample.ts',
      contentType: 'editor',
      label: 'sample.ts',
      sortOrder: 1
    }
    const terminalState: TerminalTab = {
      id: terminal.entityId,
      ptyId: null,
      worktreeId: group.worktreeId,
      title: terminal.label,
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 1
    }
    const worktreeState: TabGroupWorktreeSnapshot = {
      groups: [group],
      unifiedTabs: [terminal, editor],
      terminalTabs: [terminalState],
      openFiles: [],
      browserTabs: [],
      expandedPaneByTabId: {},
      terminalLayoutsByTabId: {},
      generatedTabTitlesEnabled: false,
      mobileEmulatorEnabled: false
    }

    const { result } = renderHook(() =>
      useTabGroupItemProjections({
        groupId: group.id,
        worktreeId: group.worktreeId,
        worktreeState,
        terminalOnly: true
      })
    )

    expect(result.current.groupTabs.map((tab) => tab.id)).toEqual(['terminal-tab'])
    expect(result.current.tabBarOrder).toEqual(['terminal-entity'])
    expect(result.current.activeTab).toBeNull()
  })
})
