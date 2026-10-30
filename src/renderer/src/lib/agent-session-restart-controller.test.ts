import { describe, expect, it, vi } from 'vitest'
import {
  planAgentSessionRestarts,
  type AgentSessionRestartPane
} from './agent-session-restart-plan'
import { createAgentSessionRestartController } from './agent-session-restart-controller'
import type { AgentSessionRestartOutcome } from './agent-session-restart-run'

function pane(overrides: Partial<AgentSessionRestartPane> = {}): AgentSessionRestartPane {
  return {
    ptyId: 'pty-1',
    tabId: 'tab-1',
    leafId: '0195f2ce-1111-4000-8000-000000000001',
    worktreeId: 'wt-1',
    workspaceLabel: 'repo',
    tabGeneration: 1,
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

function outcome(
  ptyId: string,
  status: AgentSessionRestartOutcome['status']
): AgentSessionRestartOutcome {
  return {
    ptyId,
    agent: 'claude',
    label: 'Claude',
    workspaceLabel: 'repo',
    status,
    message: status,
    newPtyId: status === 'succeeded' ? 'pty-new' : null,
    reapPtyId: null
  }
}

describe('createAgentSessionRestartController', () => {
  it('scopes a runtime recovery to the selected Codex and keeps its queued fence', async () => {
    let busy = true
    const run = vi.fn(async (targets) =>
      targets.map((target) =>
        outcome(target.pane.ptyId, target.kind === 'queued' ? 'queued' : 'succeeded')
      )
    )
    const controller = createAgentSessionRestartController({
      plan: () =>
        planAgentSessionRestarts({
          enabledCatalog: ['codex'],
          panes: [
            pane({ agent: 'codex', state: busy ? 'working' : 'done' }),
            pane({ agent: 'codex', ptyId: 'other-codex' })
          ]
        }),
      run
    })
    await controller.request('codex', ['pty-1'])
    expect(controller.getSnapshot().outcomes.map((entry) => entry.ptyId)).toEqual(['pty-1'])
    busy = false
    await controller.promote()
    expect(controller.getSnapshot().outcomes.map((entry) => entry.status)).toEqual(['succeeded'])
    expect(
      run.mock.calls.flatMap(([targets]) => targets.map((target) => target.pane.ptyId))
    ).toEqual(['pty-1', 'pty-1'])
  })
  it('replaces completed results on each request and dismisses them', async () => {
    let ptyId = 'old-pty'
    const controller = createAgentSessionRestartController({
      plan: () =>
        planAgentSessionRestarts({ enabledCatalog: ['claude'], panes: [pane({ ptyId })] }),
      run: async (targets) => targets.map((target) => outcome(target.pane.ptyId, 'succeeded'))
    })
    await controller.request('all')
    ptyId = 'replacement-pty'
    await controller.request('all')
    expect(controller.getSnapshot().outcomes.map((item) => item.ptyId)).toEqual(['replacement-pty'])
    controller.dismiss()
    expect(controller.getSnapshot().outcomes).toEqual([])
  })

  it('dismissal and a new scope keep pending work and its original fence', async () => {
    let busy = true
    const controller = createAgentSessionRestartController({
      plan: () =>
        planAgentSessionRestarts({
          enabledCatalog: ['claude'],
          panes: [pane({ state: busy ? 'working' : 'done' })]
        }),
      run: async (targets) =>
        targets.map((target) =>
          outcome(target.pane.ptyId, target.kind === 'queued' ? 'queued' : 'succeeded')
        )
    })
    await controller.request('claude')
    controller.dismiss()
    await controller.request('codex')
    expect(controller.hasWaiting()).toBe(true)
    expect(controller.getSnapshot().outcomes[0]?.status).toBe('queued')
    busy = false
    await controller.promote()
    expect(controller.getSnapshot().outcomes[0]?.status).toBe('succeeded')
  })

  it('keeps a busy agent queued and restarts it once the same session is idle', async () => {
    let busy = true
    const run = vi.fn(async (targets) =>
      targets.map((target) =>
        outcome(target.pane.ptyId, target.kind === 'queued' ? 'queued' : 'succeeded')
      )
    )
    const controller = createAgentSessionRestartController({
      plan: () =>
        planAgentSessionRestarts({
          enabledCatalog: ['claude'],
          panes: [pane({ state: busy ? 'working' : 'done' })]
        }),
      run
    })

    await controller.request('all')
    expect(controller.getSnapshot().outcomes.map((item) => item.status)).toEqual(['queued'])
    expect(controller.hasWaiting()).toBe(true)

    busy = false
    await controller.promote()
    expect(run).toHaveBeenCalledTimes(2)
    expect(controller.getSnapshot().outcomes.map((item) => item.status)).toEqual(['succeeded'])
    expect(controller.hasWaiting()).toBe(false)
  })

  it('skips a queued pane that disappeared instead of spawning it', async () => {
    let present = true
    const run = vi.fn(async (targets) =>
      targets.map((target) => outcome(target.pane.ptyId, 'queued'))
    )
    const controller = createAgentSessionRestartController({
      plan: () =>
        planAgentSessionRestarts({
          enabledCatalog: ['claude'],
          panes: present ? [pane({ state: 'blocked' })] : []
        }),
      run
    })

    await controller.request('claude')
    present = false
    await controller.promote()

    expect(run).toHaveBeenCalledTimes(1)
    expect(controller.getSnapshot().outcomes[0]).toMatchObject({
      status: 'skipped',
      message: 'the terminal was closed'
    })
    expect(controller.hasWaiting()).toBe(false)
  })

  it('does not start a second request while one is running', async () => {
    const gate: { release: (() => void) | null } = { release: null }
    const run = vi.fn(
      () =>
        new Promise<AgentSessionRestartOutcome[]>((resolve) => {
          gate.release = () => resolve([outcome('pty-1', 'succeeded')])
        })
    )
    const controller = createAgentSessionRestartController({
      plan: () => planAgentSessionRestarts({ enabledCatalog: ['claude'], panes: [pane()] }),
      run
    })

    const first = controller.request('all')
    await controller.request('all')
    expect(run).toHaveBeenCalledTimes(1)
    gate.release?.()
    await first
    expect(controller.getSnapshot().running).toBe(false)
  })

  it('skips a queued pty whose session was replaced before it became idle', async () => {
    let sessionId = 'sess-a'
    let busy = true
    const run = vi.fn(async (targets) =>
      targets.map((target) =>
        outcome(target.pane.ptyId, target.kind === 'queued' ? 'queued' : 'succeeded')
      )
    )
    const controller = createAgentSessionRestartController({
      plan: () =>
        planAgentSessionRestarts({
          enabledCatalog: ['claude'],
          panes: [
            pane({
              state: busy ? 'working' : 'done',
              providerSession: { key: 'session_id', id: sessionId }
            })
          ]
        }),
      run
    })

    await controller.request('all')
    sessionId = 'sess-b'
    busy = false
    await controller.promote()

    expect(run).toHaveBeenCalledTimes(1)
    expect(controller.getSnapshot().outcomes[0]).toMatchObject({
      status: 'skipped',
      message: 'the terminal changed before restart'
    })
  })

  it('promotes an idle transition that arrived while a restart was running', async () => {
    let busy = true
    const gate: { release: (() => void) | null } = { release: null }
    let calls = 0
    const run = vi.fn((targets: readonly { kind: string; pane: { ptyId: string } }[]) => {
      calls += 1
      const settled = targets.map((target) =>
        outcome(target.pane.ptyId, target.kind === 'queued' ? 'queued' : 'succeeded')
      )
      if (calls > 1) {
        return Promise.resolve(settled)
      }
      return new Promise<AgentSessionRestartOutcome[]>((resolve) => {
        gate.release = () => {
          busy = false
          resolve(settled)
        }
      })
    })
    const controller = createAgentSessionRestartController({
      plan: () =>
        planAgentSessionRestarts({
          enabledCatalog: ['claude'],
          panes: [pane({ state: busy ? 'working' : 'done' })]
        }),
      run
    })

    const pending = controller.request('all')
    await controller.promote()
    gate.release?.()
    await pending

    expect(run).toHaveBeenCalledTimes(2)
    expect(controller.getSnapshot().outcomes[0]?.status).toBe('succeeded')
  })
})
