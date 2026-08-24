import { describe, expect, it, vi } from 'vitest'
import type * as ReactActual from 'react'
import { resolveTerminalTabTitle } from '../../../../shared/tab-title-resolution'
import type { Tab, TabGroup } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import {
  useTabGroupItemProjections,
  type TabGroupWorktreeSnapshot
} from './useTabGroupItemProjections'

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof ReactActual>('react')
  return {
    ...actual,
    useMemo: <T>(factory: () => T) => factory()
  }
})

const WORKTREE_ID = 'wt-1'
const GROUP_ID = 'group-1'
const TAB_ID = 'term-1'
const NOW = 1_700_000_000_000

const aiVaultTitle = {
  agent: 'claude' as const,
  sessionId: 'claude-session-1',
  title: 'Housekeeping'
}

function makeTerminalTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: TAB_ID,
    ptyId: 'pty-1',
    worktreeId: WORKTREE_ID,
    title: '✳ pull again',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: NOW,
    generatedTitle: 'Pull again',
    aiVaultTitle,
    ...overrides
  }
}

function makeUnifiedTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: 'unified-term-1',
    entityId: TAB_ID,
    groupId: GROUP_ID,
    worktreeId: WORKTREE_ID,
    contentType: 'terminal',
    label: '✳ pull again',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: NOW,
    generatedLabel: 'Pull again',
    aiVaultTitle,
    ...overrides
  }
}

function makeState(args: {
  terminalTab?: TerminalTab
  unifiedTab?: Tab
}): TabGroupWorktreeSnapshot {
  const terminalTab = args.terminalTab ?? makeTerminalTab()
  const unifiedTab = args.unifiedTab ?? makeUnifiedTab()
  const group: TabGroup = {
    id: GROUP_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: unifiedTab.id,
    tabOrder: [unifiedTab.id]
  }
  return {
    groups: [group],
    unifiedTabs: [unifiedTab],
    terminalTabs: [terminalTab],
    openFiles: [],
    browserTabs: [],
    expandedPaneByTabId: {},
    terminalLayoutsByTabId: {},
    generatedTabTitlesEnabled: true,
    mobileEmulatorEnabled: true
  }
}

describe('useTabGroupItemProjections', () => {
  it('keeps the live AI Vault title on the tab-bar projection so generated cannot re-win', () => {
    const { terminalTabs } = useTabGroupItemProjections({
      groupId: GROUP_ID,
      worktreeId: WORKTREE_ID,
      worktreeState: makeState({})
    })

    const projected = terminalTabs[0]
    expect(projected?.aiVaultTitle).toEqual(aiVaultTitle)
    expect(projected ? resolveTerminalTabTitle(projected, true) : undefined).toBe('Housekeeping')
  })

  it('keeps an explicit-null AI Vault title on the tab-bar projection', () => {
    const { terminalTabs } = useTabGroupItemProjections({
      groupId: GROUP_ID,
      worktreeId: WORKTREE_ID,
      worktreeState: makeState({
        terminalTab: makeTerminalTab({ aiVaultTitle: null, generatedTitle: undefined }),
        unifiedTab: makeUnifiedTab({ aiVaultTitle: null, generatedLabel: undefined })
      })
    })

    expect(terminalTabs[0]?.aiVaultTitle).toBeNull()
  })

  it('uses a terminal clear when the unified tab still has stale title metadata', () => {
    const { terminalTabs } = useTabGroupItemProjections({
      groupId: GROUP_ID,
      worktreeId: WORKTREE_ID,
      worktreeState: makeState({
        terminalTab: makeTerminalTab({ aiVaultTitle: null }),
        unifiedTab: makeUnifiedTab()
      })
    })

    expect(terminalTabs[0]?.aiVaultTitle).toBeNull()
    expect(terminalTabs[0]?.title).toBe('✳ pull again')
    expect(resolveTerminalTabTitle(terminalTabs[0]!, true)).toBe('✳ pull again')
  })
})
