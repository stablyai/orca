import { describe, expect, it, vi } from 'vitest'
import {
  planAgentSessionRestarts,
  type AgentSessionRestartPane
} from './agent-session-restart-plan'
import {
  formatAgentSessionRestartOutcome,
  runAgentSessionRestartTargets,
  type AgentSessionRestartRunDeps
} from './agent-session-restart-run'
import type { AgentSessionRestartStartup } from './agent-session-restart-startup'
import type { AgentSessionRestartSpawnResult } from './agent-session-restart-verdict'

function pane(overrides: Partial<AgentSessionRestartPane> = {}): AgentSessionRestartPane {
  return {
    ptyId: 'pty-1',
    tabId: 'tab-1',
    leafId: '0195f2ce-1111-4000-8000-000000000001',
    worktreeId: 'wt-1',
    workspaceLabel: 'repo',
    tabGeneration: 2,
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'sess-1' },
    state: 'done',
    structuredHostOwned: false,
    executionHostId: 'local',
    foreignPty: false,
    wsl: false,
    ...overrides
  }
}

function startup(): AgentSessionRestartStartup {
  return {
    command: "claude '--resume' 'sess-1'",
    startupCommandDelivery: 'shell-ready',
    launchAgent: 'claude',
    resumeProviderSession: { key: 'session_id', id: 'sess-1' },
    resumeOnSelectedAccount: false
  }
}

function deps(overrides: Partial<AgentSessionRestartRunDeps> = {}) {
  const spawnMounted = vi.fn(
    async (
      _startup: AgentSessionRestartStartup,
      _pane: AgentSessionRestartPane
    ): Promise<AgentSessionRestartSpawnResult> => ({
      id: 'pty-new',
      resumeProviderSession: { id: 'sess-1' }
    })
  )
  const spawnUnmounted = vi.fn(
    async (
      _startup: AgentSessionRestartStartup,
      _pane: AgentSessionRestartPane
    ): Promise<AgentSessionRestartSpawnResult> => ({
      id: 'pty-new',
      resumeProviderSession: { id: 'sess-1' }
    })
  )
  const buildStartup = vi.fn(() => startup())
  return {
    revalidate: () => 'ok' as const,
    placement: () => 'mounted' as const,
    ...overrides,
    buildStartup: overrides.buildStartup ?? buildStartup,
    spawnMounted: overrides.spawnMounted ?? spawnMounted,
    spawnUnmounted: overrides.spawnUnmounted ?? spawnUnmounted
  }
}

describe('runAgentSessionRestartTargets', () => {
  it('does not spawn a skip or a queued agent', async () => {
    const plan = planAgentSessionRestarts({
      enabledCatalog: ['claude', 'trae'],
      panes: [
        pane({ ptyId: 'busy', state: 'working' }),
        pane({ ptyId: 'trae', agent: 'trae', providerSession: null }),
        pane({ ptyId: 'remote', executionHostId: 'ssh:box' })
      ]
    })
    const run = deps()

    const outcomes = await runAgentSessionRestartTargets(plan.targets, run)

    expect(run.spawnMounted).not.toHaveBeenCalled()
    expect(run.spawnUnmounted).not.toHaveBeenCalled()
    expect(run.buildStartup).not.toHaveBeenCalled()
    expect(outcomes.map((item) => [item.ptyId, item.status])).toEqual([
      ['busy', 'queued'],
      ['trae', 'skipped'],
      ['remote', 'skipped']
    ])
    expect(formatAgentSessionRestartOutcome(outcomes[0]!)).toBe(
      'Queued: Claude in repo — waiting until it is idle'
    )
    expect(formatAgentSessionRestartOutcome(outcomes[1]!)).toBe(
      'Skipped: Trae — this CLI cannot resume a session'
    )
  })

  it('does not spawn when the fenced pane was removed or replaced', async () => {
    const plan = planAgentSessionRestarts({
      enabledCatalog: ['claude'],
      panes: [pane({ ptyId: 'gone' }), pane({ ptyId: 'replaced' })]
    })
    const run = deps({
      revalidate: (fence) => (fence.ptyId === 'gone' ? 'removed' : 'pane-changed')
    })

    const outcomes = await runAgentSessionRestartTargets(plan.targets, run)

    expect(run.spawnMounted).not.toHaveBeenCalled()
    expect(outcomes.map((item) => item.message)).toEqual([
      'the terminal was closed',
      'the terminal changed before restart'
    ])
  })

  it('leaves an open terminal pending until its pane can accept the restart', async () => {
    const plan = planAgentSessionRestarts({
      enabledCatalog: ['grok'],
      panes: [pane({ agent: 'grok', providerSession: { key: 'session_id', id: 'sess-1' } })]
    })
    const run = deps({ placement: () => 'open-unready' })

    const [outcome] = await runAgentSessionRestartTargets(plan.targets, run)

    expect(run.spawnMounted).not.toHaveBeenCalled()
    expect(run.spawnUnmounted).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ status: 'pending', message: 'Waiting for the open terminal' })
  })

  it('fails a thrown spawn and a shell that did not restore the session', async () => {
    const plan = planAgentSessionRestarts({
      enabledCatalog: ['codex', 'claude'],
      panes: [
        pane({
          ptyId: 'throws',
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'codex-1' }
        }),
        pane({ ptyId: 'dropped' }),
        pane({ ptyId: 'reattach' }),
        pane({ ptyId: 'refused' }),
        pane({ ptyId: 'ok' })
      ]
    })
    const results = new Map<string, AgentSessionRestartSpawnResult | 'throw'>([
      ['throws', 'throw'],
      ['dropped', { id: 'pty-shell', resumeProviderSession: undefined }],
      ['reattach', { id: 'pty-old', isReattach: true, resumeProviderSession: { id: 'sess-1' } }],
      ['refused', { id: 'pty-refused', agentResumeRefused: 'unverifiable' as const }],
      ['ok', { id: 'pty-ok', resumeProviderSession: { id: 'sess-1' } }]
    ])
    let cursor = 0
    const order = ['throws', 'dropped', 'reattach', 'refused', 'ok']
    const run = deps({
      placement: () => 'unmounted',
      spawnUnmounted: vi.fn(async () => {
        const key = order[cursor]!
        cursor += 1
        const value = results.get(key)
        if (value === 'throw') {
          throw new Error('spawn failed')
        }
        return value ?? {}
      })
    })

    const outcomes = await runAgentSessionRestartTargets(plan.targets, run)

    expect(run.spawnMounted).not.toHaveBeenCalled()
    expect(outcomes.map((item) => [item.ptyId, item.status, item.reapPtyId])).toEqual([
      ['throws', 'failed', null],
      ['dropped', 'failed', 'pty-shell'],
      ['reattach', 'failed', null],
      ['refused', 'failed', 'pty-refused'],
      ['ok', 'succeeded', null]
    ])
    expect(formatAgentSessionRestartOutcome(outcomes[0]!)).toBe(
      'Failed: Codex — the new process did not start'
    )
    expect(formatAgentSessionRestartOutcome(outcomes[1]!)).toBe(
      'Failed: Claude — the resume command was not accepted, so the new process was stopped'
    )
    expect(formatAgentSessionRestartOutcome(outcomes[3]!)).toBe(
      'Failed: Claude — the resume was refused (unverifiable)'
    )
    expect(formatAgentSessionRestartOutcome(outcomes[4]!)).toBe(
      'Restarted: Claude — new process started with original session resume command'
    )
  })

  it('skips when the fence breaks after the command is built', async () => {
    const plan = planAgentSessionRestarts({
      enabledCatalog: ['claude'],
      panes: [pane()]
    })
    let checks = 0
    const run = deps({
      revalidate: () => {
        checks += 1
        return checks === 1 ? 'ok' : 'pane-changed'
      }
    })

    const [outcome] = await runAgentSessionRestartTargets(plan.targets, run)

    expect(run.buildStartup).toHaveBeenCalledOnce()
    expect(run.spawnMounted).not.toHaveBeenCalled()
    expect(outcome?.status).toBe('skipped')
  })

  it('spawns a later pane that becomes idle while an earlier spawn is running', async () => {
    let secondReady = false
    const plan = planAgentSessionRestarts({
      enabledCatalog: ['claude'],
      panes: [
        pane({ ptyId: 'first' }),
        pane({
          ptyId: 'second',
          state: 'working',
          providerSession: { key: 'session_id', id: 'sess-1' }
        })
      ]
    })
    const spawnMounted = vi.fn(
      async (_startup: AgentSessionRestartStartup, spawned: AgentSessionRestartPane) => {
        if (spawned.ptyId === 'first') {
          secondReady = true
        }
        return { id: `new-${spawned.ptyId}`, resumeProviderSession: { id: 'sess-1' } }
      }
    )
    const run = deps({
      readiness: (item) => (item.ptyId === 'second' && !secondReady ? 'busy' : 'ready'),
      spawnMounted
    })

    const outcomes = await runAgentSessionRestartTargets(plan.targets, run)

    expect(spawnMounted.mock.calls.map((call) => call[1].ptyId)).toEqual(['first', 'second'])
    expect(outcomes.map((item) => item.status)).toEqual(['succeeded', 'succeeded'])
  })

  it('treats an unavailable resume as failure even when a new id came back', async () => {
    const plan = planAgentSessionRestarts({
      enabledCatalog: ['claude'],
      panes: [pane()]
    })
    const run = deps({
      spawnMounted: vi.fn(async (): Promise<AgentSessionRestartSpawnResult> => ({
        id: 'pty-new',
        agentResumeUnavailable: true,
        resumeProviderSession: { id: 'sess-1' }
      }))
    })

    const [outcome] = await runAgentSessionRestartTargets(plan.targets, run)

    expect(outcome).toMatchObject({
      status: 'failed',
      message: 'the resume command was not accepted, so the new process was stopped',
      reapPtyId: 'pty-new'
    })
  })
})
