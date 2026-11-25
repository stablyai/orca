import { expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { makeTab } from '@/store/terminals/testing/terminal-tab.test-fixture'
import { buildWorktreeAgentRows } from './worktree-agent-rows'

const CLAUDE_LEAF = '22222222-2222-4222-8222-222222222222'
const CURSOR_LEAF = '33333333-3333-4333-8333-333333333333'

function sidebarRows(worktreeId: string): string[] {
  return useAppStore
    .getState()
    .agentStatusByPaneKey.projection.list(worktreeId)
    .map((row) => `${row.paneKey}=${row.agentType}`)
    .sort()
}

function reportLegacyClaude(paneKey: string, tabId: string, worktreeId: string): void {
  useAppStore
    .getState()
    .setAgentStatus(
      paneKey,
      { state: 'working', prompt: 'fix it', agentType: 'claude' },
      '✳ Claude Code',
      undefined,
      { tabId, worktreeId }
    )
}

it('hides only the title row of the legacy status slot after a split pane closes', () => {
  // Pane 1 closed: live runtime slots 2 (Claude) and 3 (Cursor) keep their numbers.
  useAppStore.setState({
    tabsByWorktree: { 'wt-sparse': [makeTab({ id: 'sparse', worktreeId: 'wt-sparse' })] },
    terminalLayoutsByTabId: {
      sparse: {
        root: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: CLAUDE_LEAF },
          second: { type: 'leaf', leafId: CURSOR_LEAF }
        },
        activeLeafId: CLAUDE_LEAF,
        expandedLeafId: null,
        ptyIdsByLeafId: { [CLAUDE_LEAF]: 'pty-claude', [CURSOR_LEAF]: 'pty-cursor' }
      }
    },
    runtimePaneTitlesByTabId: { sparse: { 2: '✳ Claude Code', 3: 'Cursor Agent' } },
    ptyIdsByTabId: { sparse: ['pty-claude', 'pty-cursor'] }
  })

  reportLegacyClaude('sparse:2', 'sparse', 'wt-sparse')

  expect(sidebarRows('wt-sparse')).toEqual(['sparse:2=claude', `sparse:${CURSOR_LEAF}=cursor`])
})

it('still hides the tab-title row of a single-pane tab without pane titles', () => {
  useAppStore.setState({
    tabsByWorktree: {
      'wt-solo': [makeTab({ id: 'solo', worktreeId: 'wt-solo', title: '✳ Claude Code' })]
    },
    terminalLayoutsByTabId: {
      solo: {
        root: { type: 'leaf', leafId: CLAUDE_LEAF },
        activeLeafId: CLAUDE_LEAF,
        expandedLeafId: null
      }
    },
    runtimePaneTitlesByTabId: {},
    ptyIdsByTabId: { solo: ['pty-solo'] }
  })

  reportLegacyClaude('solo:1', 'solo', 'wt-solo')

  expect(sidebarRows('wt-solo')).toEqual(['solo:1=claude'])
})

it('keeps a legacy status pane working title as live cleanup evidence', () => {
  const now = 1_700_000_000_000
  const rows = buildWorktreeAgentRows({
    tabs: [makeTab({ id: 'solo', worktreeId: 'wt-solo' })],
    entries: [
      {
        paneKey: 'solo:1',
        state: 'done',
        prompt: 'fix it',
        updatedAt: now,
        stateStartedAt: now,
        agentType: 'claude',
        terminalTitle: '✳ Claude Code',
        stateHistory: []
      }
    ],
    runtimePaneTitlesByTabId: { solo: { 1: '⠋ Claude Code' } },
    ptyIdsByTabId: { solo: ['pty-solo'] },
    terminalLayoutsByTabId: {
      solo: {
        root: { type: 'leaf', leafId: CLAUDE_LEAF },
        activeLeafId: CLAUDE_LEAF,
        expandedLeafId: null
      }
    },
    now
  })

  expect(rows.map((row) => `${row.paneKey}=${row.state}`).sort()).toEqual([
    'solo:1=done',
    `solo:${CLAUDE_LEAF}=working`
  ])
})
