import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { BrowserWorkspace } from '../../../../shared/browser-workspace-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { useAppStore } from '@/store'
import { makeWorktree } from '@/components/worktree-jump-palette-test-fixtures'
import { readWindowWorkspaceActivityFacts, toLocallyOwnedRows } from './workspace-activity-shadow'

const NOW = 1_000_000

function agent(worktreeId: string, state: AgentStatusEntry['state']): AgentStatusEntry {
  return {
    state,
    prompt: '',
    updatedAt: NOW,
    stateStartedAt: NOW,
    paneKey: `tab-${worktreeId}:11111111-1111-4111-8111-111111111111`,
    worktreeId,
    stateHistory: []
  }
}

function terminalTab(id: string): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId: 'a',
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: NOW
  }
}

function browserTab(id: string): BrowserWorkspace {
  return {
    id,
    worktreeId: 'b',
    url: 'https://example.com',
    title: 'Example',
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: NOW
  }
}

describe('readWindowWorkspaceActivityFacts', () => {
  it('reads each fact from the slices the sidebar filter reads, listing only active rows', () => {
    const facts = readWindowWorkspaceActivityFacts(
      {
        tabsByWorktree: { a: [terminalTab('tab-a')], idle: [terminalTab('tab-idle')] },
        ptyIdsByTabId: { 'tab-a': ['pty-1'], 'tab-idle': [] },
        browserTabsByWorktree: { b: [browserTab('browser-1')] },
        unifiedTabsByWorktree: {},
        agentStatusByPaneKey: {
          c: agent('c', 'waiting'),
          d: agent('d', 'done')
        }
      },
      NOW
    )
    expect(Object.fromEntries(facts)).toEqual({
      a: { terminal: 'live', browser: false, structuredChat: false, agent: null },
      b: { terminal: null, browser: true, structuredChat: false, agent: null },
      c: { terminal: null, browser: false, structuredChat: false, agent: 'permission' }
    })
  })
})

describe('toLocallyOwnedRows', () => {
  it('leaves out an id a paired server also lists, since bare-id activity names no one host', () => {
    const state = {
      ...useAppStore.getState(),
      repos: [],
      folderWorkspaces: [],
      worktreesByRepo: {
        'repo-1': [
          makeWorktree('local-only', 'Local', { hostId: 'local' }),
          makeWorktree('shared', 'Local twin', { hostId: 'local' }),
          makeWorktree('shared', 'Server twin', { hostId: 'runtime:box' }),
          makeWorktree('server-only', 'Server', { hostId: 'runtime:box' })
        ]
      }
    }
    const values = new Map(['local-only', 'shared', 'server-only', 'unknown'].map((id) => [id, id]))
    expect([...toLocallyOwnedRows(state, values).keys()]).toEqual(['local-only'])
  })
})
