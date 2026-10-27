import { describe, expect, it } from 'vitest'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { collectAgentSessionRestartPlan } from './agent-session-restart-collect'

const LEAF = '0195f2ce-1111-4000-8000-000000000001'
const TAB = 'tab-1'

describe('collectAgentSessionRestartPlan', () => {
  it('counts a local agent and omits a shell, a stale leaf, and an unbound pty', () => {
    const plan = collectAgentSessionRestartPlan({
      enabledCatalog: ['claude', 'codex'],
      tabsByWorktree: {
        'wt-1': [{ id: TAB, generation: 4, worktreeId: 'wt-1' }],
        'folder:docs': [{ id: 'tab-folder', generation: 1, worktreeId: 'folder:docs' }]
      },
      terminalLayoutsByTabId: {
        [TAB]: {
          ptyIdsByLeafId: {
            [LEAF]: 'pty-claude',
            '0195f2ce-2222-4000-8000-000000000003': 'pty-shell'
          }
        },
        'tab-folder': {
          ptyIdsByLeafId: { '0195f2ce-1111-4000-8000-000000000002': 'pty-grok' }
        }
      },
      ptyIdsByTabId: {
        [TAB]: ['pty-claude', 'pty-shell', 'pty-unbound'],
        'tab-folder': ['pty-grok']
      },
      agentStatusByPaneKey: {
        [makePaneKey(TAB, LEAF)]: {
          agentType: 'claude',
          state: 'done',
          providerSession: { key: 'session_id', id: 'sess-1' }
        },
        [makePaneKey('tab-folder', '0195f2ce-1111-4000-8000-000000000002')]: {
          agentType: 'grok',
          state: 'done',
          providerSession: { key: 'session_id', id: 'grok-1' },
          structuredHostOwned: true
        }
      },
      workspaceLabel: (id) => (id === 'folder:docs' ? 'Docs' : 'repo'),
      executionHostId: (id) => (id === 'wt-1' ? 'local' : 'local'),
      wsl: () => false
    })

    expect(plan.restartAllCount).toBe(1)
    expect(plan.targets.map((target) => [target.pane.ptyId, target.kind])).toEqual([
      ['pty-claude', 'restart'],
      ['pty-grok', 'skipped']
    ])
    expect(plan.targets[1]).toMatchObject({ reason: 'structured-session' })
    expect(plan.rows.find((row) => row.agent === 'claude')).toMatchObject({
      liveCount: 1,
      disabled: false
    })
  })

  it('does not count another host, and does not treat an unknown host as local', () => {
    const plan = collectAgentSessionRestartPlan({
      enabledCatalog: ['claude'],
      tabsByWorktree: {
        remote: [{ id: 'tab-r', generation: 1 }],
        unknown: [{ id: 'tab-u', generation: 1 }]
      },
      terminalLayoutsByTabId: {
        'tab-r': { ptyIdsByLeafId: { [LEAF]: 'pty-r' } },
        'tab-u': { ptyIdsByLeafId: { [LEAF]: 'pty-u' } }
      },
      ptyIdsByTabId: { 'tab-r': ['pty-r'], 'tab-u': ['pty-u'] },
      agentStatusByPaneKey: {
        [makePaneKey('tab-r', LEAF)]: {
          agentType: 'claude',
          state: 'done',
          providerSession: { key: 'session_id', id: 'r' }
        },
        [makePaneKey('tab-u', LEAF)]: {
          agentType: 'claude',
          state: 'working',
          providerSession: { key: 'session_id', id: 'u' }
        }
      },
      workspaceLabel: (id) => id,
      executionHostId: (id) => (id === 'remote' ? 'ssh:box' : null),
      wsl: () => false,
      foreignPty: () => false
    })

    expect(plan.restartAllCount).toBe(0)
    expect(
      plan.targets.map((target) => (target.kind === 'skipped' ? target.reason : target.kind))
    ).toEqual(['remote-unsupported', 'unknown-host'])
  })

  it('skips a stale shell row and a non-terminal row, and restarts a local folder agent', () => {
    const folderLeaf = '0195f2ce-1111-4000-8000-000000000004'
    const chatLeaf = '0195f2ce-1111-4000-8000-000000000005'
    const plan = collectAgentSessionRestartPlan({
      enabledCatalog: ['claude', 'grok'],
      tabsByWorktree: {
        'wt-1': [{ id: TAB, generation: 2, worktreeId: 'wt-1' }],
        'folder:docs': [{ id: 'tab-folder', generation: 1, worktreeId: 'folder:docs' }],
        'wt-chat': [{ id: 'tab-chat', generation: 1 }]
      },
      terminalLayoutsByTabId: {
        [TAB]: { ptyIdsByLeafId: { [LEAF]: 'pty-stale' } },
        'tab-folder': { ptyIdsByLeafId: { [folderLeaf]: 'pty-folder' } },
        'tab-chat': { ptyIdsByLeafId: { [chatLeaf]: 'pty-chat' } }
      },
      ptyIdsByTabId: {
        [TAB]: ['pty-stale'],
        'tab-folder': ['pty-folder'],
        'tab-chat': ['pty-chat']
      },
      agentStatusByPaneKey: {
        [makePaneKey(TAB, LEAF)]: {
          agentType: 'claude',
          state: 'done',
          restoredUnconfirmed: true,
          providerSession: { key: 'session_id', id: 'old' }
        },
        [makePaneKey('tab-folder', folderLeaf)]: {
          agentType: 'grok',
          state: 'done',
          providerSession: { key: 'session_id', id: 'grok-folder' }
        },
        [makePaneKey('tab-chat', chatLeaf)]: {
          agentType: 'claude',
          state: 'done',
          terminalResumeEligible: false,
          providerSession: { key: 'session_id', id: 'chat' }
        }
      },
      workspaceLabel: (id) => (id === 'folder:docs' ? 'Docs' : 'repo'),
      executionHostId: () => 'local',
      wsl: () => false,
      shellForeground: (paneKey) => paneKey === makePaneKey(TAB, LEAF)
    })

    expect(plan.restartAllCount).toBe(1)
    expect(
      plan.targets.map((target) => [
        target.pane.ptyId,
        target.kind,
        target.kind === 'skipped' ? target.reason : ''
      ])
    ).toEqual([
      ['pty-stale', 'skipped', 'stale-status'],
      ['pty-folder', 'restart', ''],
      ['pty-chat', 'skipped', 'non-terminal']
    ])
    expect(plan.targets[1]).toMatchObject({ workspaceLabel: 'Docs' })
  })
})
