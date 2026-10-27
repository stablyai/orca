import { describe, expect, it } from 'vitest'
import type { TuiAgent } from '../../../shared/tui-agent'
import {
  agentSessionRestartFenceHolds,
  agentSessionRestartSkipMessage,
  classifyAgentSessionRestartPane,
  formatAgentSessionRestartRowLabel,
  formatRestartAllAgentsLabel,
  isAgentSessionRestartAgent,
  planAgentSessionRestarts,
  selectAgentSessionRestartTargets,
  type AgentSessionRestartPane
} from './agent-session-restart-plan'

const ENABLED: TuiAgent[] = ['claude', 'codex', 'grok', 'antigravity', 'cursor', 'trae']

function pane(overrides: Partial<AgentSessionRestartPane> = {}): AgentSessionRestartPane {
  return {
    ptyId: 'pty-1',
    tabId: 'tab-1',
    leafId: '0195f2ce-1111-4000-8000-000000000001',
    worktreeId: 'wt-1',
    workspaceLabel: 'repo',
    tabGeneration: 3,
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'sess-claude' },
    state: 'done',
    structuredHostOwned: false,
    executionHostId: 'local',
    foreignPty: false,
    wsl: false,
    ...overrides
  }
}

describe('planAgentSessionRestarts', () => {
  it('groups live agents without filling the menu with unused catalog entries', () => {
    const plan = planAgentSessionRestarts({
      enabledCatalog: ENABLED,
      panes: [
        pane({ ptyId: 'g1', agent: 'grok', providerSession: { key: 'session_id', id: 'g' } }),
        pane({ ptyId: 'c1', agent: 'claude' }),
        pane({
          ptyId: 'c2',
          agent: 'claude',
          providerSession: { key: 'session_id', id: 'sess-2' },
          state: 'working'
        })
      ]
    })

    expect(plan.rows.map((row) => formatAgentSessionRestartRowLabel(row))).toEqual([
      'Claude (2)',
      'Grok (1)'
    ])
    expect(plan.rows.filter((row) => row.disabled)).toEqual([])
    expect(plan.restartAllCount).toBe(3)
    expect(formatRestartAllAgentsLabel(plan.restartAllCount)).toBe('Restart all agents (3)')
  })

  it('includes a disabled catalog agent only while it is live', () => {
    const idle = planAgentSessionRestarts({
      enabledCatalog: ['claude', 'codex'],
      panes: [pane()]
    })
    expect(idle.rows.map((row) => row.agent)).toEqual(['claude'])

    const running = planAgentSessionRestarts({
      enabledCatalog: ['claude', 'codex'],
      panes: [
        pane(),
        pane({
          ptyId: 'trae-1',
          agent: 'trae',
          providerSession: null
        })
      ]
    })
    expect(running.rows.map((row) => [row.agent, row.liveCount, row.disabled])).toEqual([
      ['claude', 1, false],
      ['trae', 1, true]
    ])
  })

  it('omits shells and counts only this host', () => {
    const plan = planAgentSessionRestarts({
      enabledCatalog: ['claude', 'grok'],
      panes: [
        pane({ ptyId: 'shell', agent: 'bash' }),
        pane({ ptyId: 'server', agent: 'npm' }),
        pane({
          ptyId: 'remote-claude',
          executionHostId: 'ssh:box',
          workspaceLabel: 'remote'
        }),
        pane({
          ptyId: 'foreign',
          foreignPty: true,
          providerSession: { key: 'session_id', id: 'foreign' }
        }),
        pane({
          ptyId: 'unknown-host',
          executionHostId: null
        }),
        pane({
          ptyId: 'chat',
          structuredHostOwned: true,
          agent: 'grok',
          providerSession: { key: 'session_id', id: 'chat' }
        }),
        pane({
          ptyId: 'local-grok',
          agent: 'grok',
          providerSession: { key: 'session_id', id: 'g' }
        })
      ]
    })

    expect(isAgentSessionRestartAgent('bash')).toBe(false)
    expect(plan.targets.map((target) => target.pane.ptyId)).toEqual([
      'remote-claude',
      'foreign',
      'unknown-host',
      'chat',
      'local-grok'
    ])
    expect(plan.restartAllCount).toBe(1)
    expect(plan.rows.map((row) => [row.agent, row.liveCount])).toEqual([['grok', 1]])
    expect(
      plan.targets.map((target) => (target.kind === 'skipped' ? target.reason : target.kind))
    ).toEqual([
      'remote-unsupported',
      'remote-unsupported',
      'unknown-host',
      'structured-session',
      'restart'
    ])
  })

  it('queues a busy or blocked turn and restarts only a done exact session', () => {
    const plan = planAgentSessionRestarts({
      enabledCatalog: ['claude', 'codex', 'grok', 'cursor', 'antigravity'],
      panes: [
        pane({ ptyId: 'working', state: 'working' }),
        pane({
          ptyId: 'waiting',
          state: 'waiting',
          providerSession: { key: 'session_id', id: 'w' }
        }),
        pane({
          ptyId: 'blocked',
          state: 'blocked',
          providerSession: { key: 'session_id', id: 'b' }
        }),
        pane({ ptyId: 'done', state: 'done' }),
        pane({ ptyId: 'no-id', providerSession: null }),
        pane({
          ptyId: 'cursor-wrong-key',
          agent: 'cursor',
          providerSession: { key: 'session_id', id: 'not-a-conversation' }
        }),
        pane({
          ptyId: 'cursor-ok',
          agent: 'cursor',
          providerSession: { key: 'conversation_id', id: 'conv-1' }
        }),
        pane({
          ptyId: 'agy',
          agent: 'antigravity',
          providerSession: { key: 'conversation_id', id: 'agy-1' }
        }),
        pane({
          ptyId: 'trae',
          agent: 'trae',
          providerSession: { key: 'session_id', id: 'trae-session' }
        }),
        pane({
          ptyId: 'wsl-codex',
          agent: 'codex',
          wsl: true,
          providerSession: { key: 'session_id', id: 'codex-wsl' }
        }),
        pane({
          ptyId: 'wsl-claude',
          agent: 'claude',
          wsl: true,
          providerSession: { key: 'session_id', id: 'claude-wsl' }
        }),
        pane({
          ptyId: 'pi-no-file',
          agent: 'pi',
          providerSession: { key: 'session_id', id: 'pi-1' }
        })
      ]
    })

    const byId = Object.fromEntries(plan.targets.map((target) => [target.pane.ptyId, target]))
    expect(byId.working).toMatchObject({ kind: 'queued', queueReason: 'busy' })
    expect(byId.waiting).toMatchObject({ kind: 'queued', queueReason: 'busy' })
    expect(byId.blocked).toMatchObject({ kind: 'queued', queueReason: 'blocked' })
    expect(byId.done).toMatchObject({
      kind: 'restart',
      fence: {
        ptyId: 'done',
        tabGeneration: 3,
        agent: 'claude',
        providerSessionId: 'sess-claude',
        providerSessionKey: 'session_id'
      }
    })
    expect(byId['no-id']).toMatchObject({ kind: 'skipped', reason: 'missing-session' })
    expect(byId['cursor-wrong-key']).toMatchObject({ kind: 'skipped', reason: 'missing-session' })
    expect(byId['cursor-ok']).toMatchObject({
      kind: 'restart',
      fence: { providerSessionId: 'conv-1', providerSessionKey: 'conversation_id', agent: 'cursor' }
    })
    expect(byId.agy).toMatchObject({
      kind: 'restart',
      fence: { agent: 'antigravity', providerSessionKey: 'conversation_id' }
    })
    expect(byId.trae).toMatchObject({ kind: 'skipped', reason: 'resume-unsupported' })
    expect(byId['wsl-codex']).toMatchObject({ kind: 'skipped', reason: 'wsl-resume-unsupported' })
    expect(byId['wsl-claude']).toMatchObject({ kind: 'restart' })
    expect(byId['pi-no-file']).toMatchObject({ kind: 'skipped', reason: 'missing-session' })
    expect(plan.rows.find((row) => row.agent === 'trae')?.liveCount).toBe(1)
    expect(plan.rows.find((row) => row.agent === 'codex')?.liveCount).toBe(1)
    expect(agentSessionRestartSkipMessage('resume-unsupported')).toBe(
      'this CLI cannot resume a session'
    )
    expect(agentSessionRestartSkipMessage('remote-unsupported')).toContain('left running')
  })

  it('selects one CLI without dropping an explicit remote skip for that CLI', () => {
    const plan = planAgentSessionRestarts({
      enabledCatalog: ['claude', 'grok'],
      panes: [
        pane({ ptyId: 'local' }),
        pane({ ptyId: 'remote', executionHostId: 'runtime:env-1' }),
        pane({ ptyId: 'grok', agent: 'grok', providerSession: { key: 'session_id', id: 'g' } })
      ]
    })
    expect(
      selectAgentSessionRestartTargets(plan.targets, 'claude').map((target) => target.pane.ptyId)
    ).toEqual(['local', 'remote'])
    expect(selectAgentSessionRestartTargets(plan.targets, 'all')).toHaveLength(3)
    expect(plan.restartAllCount).toBe(2)
  })

  it('rejects a fenced restart when the pane or session was replaced', () => {
    const target = classifyAgentSessionRestartPane(pane())
    expect(target?.kind).toBe('restart')
    if (target?.kind !== 'restart') {
      return
    }
    const current = {
      ptyBoundToTab: true,
      leafPtyId: target.fence.ptyId,
      tabGeneration: target.fence.tabGeneration,
      agent: target.fence.agent,
      providerSessionId: target.fence.providerSessionId,
      providerSessionKey: target.fence.providerSessionKey,
      worktreeId: target.fence.worktreeId
    }
    expect(agentSessionRestartFenceHolds(target.fence, current)).toBe(true)
    expect(
      agentSessionRestartFenceHolds(target.fence, { ...current, providerSessionId: 'other' })
    ).toBe(false)
    expect(agentSessionRestartFenceHolds(target.fence, { ...current, tabGeneration: 4 })).toBe(
      false
    )
    expect(agentSessionRestartFenceHolds(target.fence, { ...current, leafPtyId: 'pty-new' })).toBe(
      false
    )
    expect(agentSessionRestartFenceHolds(target.fence, { ...current, ptyBoundToTab: false })).toBe(
      false
    )
  })

  it('treats an unsafe session id as missing instead of a restart', () => {
    const target = classifyAgentSessionRestartPane(
      pane({ providerSession: { key: 'session_id', id: 'bad\nid' } })
    )
    expect(target).toMatchObject({ kind: 'skipped', reason: 'missing-session' })
  })
})
