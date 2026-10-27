import { describe, expect, it } from 'vitest'
import { collectAgentSessionRestartPlan } from './agent-session-restart-collect'
import { formatAgentSessionRestartRowLabel } from './agent-session-restart-plan'
import { makePaneKey } from '../../../shared/stable-pane-id'

const LEAF = '0195f2ce-1111-4000-8000-000000000001'

describe('restart menu readiness', () => {
  it('excludes missing launch/session evidence before a user requests restart', () => {
    const plan = collectAgentSessionRestartPlan({
      enabledCatalog: ['claude', 'codex', 'antigravity', 'cursor'],
      tabsByWorktree: { wt: [{ id: 'manual' }, { id: 'ready' }, { id: 'empty' }] },
      terminalLayoutsByTabId: {
        manual: { ptyIdsByLeafId: { [LEAF]: 'pty-manual' } },
        ready: { ptyIdsByLeafId: { [LEAF]: 'pty-ready' } },
        empty: { ptyIdsByLeafId: { [LEAF]: 'pty-empty' } }
      },
      ptyIdsByTabId: { manual: ['pty-manual'], ready: ['pty-ready'], empty: ['pty-empty'] },
      agentStatusByPaneKey: {
        [makePaneKey('manual', LEAF)]: {
          agentType: 'claude',
          state: 'done',
          providerSession: { key: 'session_id', id: 'manual' }
        },
        [makePaneKey('ready', LEAF)]: {
          agentType: 'claude',
          state: 'working',
          providerSession: { key: 'session_id', id: 'ready' }
        },
        [makePaneKey('empty', LEAF)]: { agentType: 'codex', state: 'done' }
      },
      workspaceLabel: () => 'Test',
      executionHostId: () => 'local',
      wsl: () => false,
      startupUnavailableReason: (pane) => (pane.tabId === 'manual' ? 'unknown-launch' : undefined)
    })
    expect(plan.restartAllCount).toBe(1)
    expect(plan.rows.map(formatAgentSessionRestartRowLabel)).toEqual([
      'Claude (1 of 2 can restart)',
      'Codex (0 of 1 can restart)'
    ])
    expect(plan.rows[1]?.disabled).toBe(true)
    expect(plan.targets).toEqual([
      expect.objectContaining({ kind: 'skipped', reason: 'unknown-launch' }),
      expect.objectContaining({ kind: 'queued', queueReason: 'busy' }),
      expect.objectContaining({ kind: 'skipped', reason: 'missing-session' })
    ])
  })
})
