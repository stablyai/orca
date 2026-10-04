import { describe, expect, it } from 'vitest'
import type { WorkspaceTabPaletteSearchResult } from '@/lib/workspace-tab-palette-search'
import type { TabPaneInputSources } from '@/components/sidebar/smart-attention'
import type { AgentJournalTurnOutcome } from '../../../shared/agent-turn-outcome'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import { shouldIncludeOpenTabInRecentSection } from './worktree-jump-palette-recent-inclusion'
import { makeAgentEntry, makeWorktree } from './worktree-jump-palette-test-fixtures'

const NOW = 1_700_000_000_000
const TAB_ID = 'terminal-1'

function currentTabResult(): WorkspaceTabPaletteSearchResult {
  return {
    tabId: 'unified-terminal-1',
    entityId: TAB_ID,
    worktreeId: 'wt-1',
    groupId: 'group-1',
    contentType: 'terminal',
    occupantAgent: null,
    title: 'Terminal',
    secondaryText: '',
    secondaryMatches: [],
    repoName: 'repo/orca',
    worktreeName: 'Palette Worktree',
    branchName: 'main',
    titleRanges: [],
    secondaryRanges: [],
    repoRanges: [],
    worktreeRanges: [],
    branchRanges: [],
    typeAliasMatches: [],
    isCurrentTab: true,
    isCurrentWorktree: true,
    score: 0,
    qualityClass: null,
    rank: null,
    paletteIdentity: `terminal\u0000wt-1\u0000group-1\u0000unified-terminal-1`,
    lastActiveAt: null,
    activity: { ageBucket: null, timestamp: 0 }
  }
}

function includesCurrentTabWith(entry: AgentStatusEntry): boolean {
  const paneSources: TabPaneInputSources = {
    entriesByTabId: new Map([[TAB_ID, [entry]]]),
    ptyIdsByTabId: {},
    runtimePaneTitlesByTabId: {}
  }
  return shouldIncludeOpenTabInRecentSection({
    item: { id: 'item-1', type: 'workspace-tab', result: currentTabResult() },
    worktree: makeWorktree('wt-1', 'Palette Worktree'),
    row: {
      id: TAB_ID,
      worktreeId: 'wt-1',
      unifiedTabId: 'unified-terminal-1',
      terminalTab: { id: TAB_ID, title: 'zsh' },
      worktreeLastActivityAt: 0
    },
    paneSources,
    unreadTerminalTabs: {},
    unreadAgentCompletionPanes: {},
    now: NOW
  })
}

function doneWith(outcome?: AgentJournalTurnOutcome): AgentStatusEntry {
  return makeAgentEntry(
    TAB_ID,
    'done',
    NOW - 1_000,
    outcome ? { mainAgent: { state: 'done', outcome, stateStartedAt: NOW - 1_000 } } : {}
  )
}

describe('shouldIncludeOpenTabInRecentSection', () => {
  it('keeps the current tab out of Recent once its turn settled, a failure like a completion', () => {
    expect(includesCurrentTabWith(doneWith())).toBe(false)
    expect(includesCurrentTabWith(doneWith('cancellation'))).toBe(false)
    expect(includesCurrentTabWith(doneWith('failure'))).toBe(false)
  })

  it('keeps the current tab in Recent while its agent still works', () => {
    expect(includesCurrentTabWith(makeAgentEntry(TAB_ID, 'working', NOW - 1_000))).toBe(true)
  })
})
