import { describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import {
  planAgentSessionRestarts,
  type AgentSessionRestartPane
} from './agent-session-restart-plan'
import { createAgentSessionRestartController } from './agent-session-restart-controller'
import type { AgentSessionRestartOutcome } from './agent-session-restart-run'
import {
  installAgentSessionRestartPromoter,
  setAgentSessionRestartControllerForTests
} from './agent-session-restart-service'

function pane(state: AgentSessionRestartPane['state']): AgentSessionRestartPane {
  return {
    ptyId: 'pty-1',
    tabId: 'tab-1',
    leafId: '0195f2ce-1111-4000-8000-000000000001',
    worktreeId: 'wt-1',
    workspaceLabel: 'repo',
    tabGeneration: 1,
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'sess-1' },
    state,
    structuredHostOwned: false,
    executionHostId: 'local',
    foreignPty: false,
    wsl: false
  }
}

describe('installAgentSessionRestartPromoter', () => {
  it('schedules a follow-up when a queued pane becomes idle during the batch', async () => {
    let busy = true
    const gate: { release: (() => void) | null } = { release: null }
    let calls = 0
    const run = vi.fn((targets: readonly { kind: string; pane: { ptyId: string } }[]) => {
      calls += 1
      const outcomes: AgentSessionRestartOutcome[] = targets.map((target) => ({
        ptyId: target.pane.ptyId,
        agent: 'claude',
        label: 'Claude',
        workspaceLabel: 'repo',
        status: target.kind === 'queued' ? 'queued' : 'succeeded',
        message: target.kind,
        newPtyId: null,
        reapPtyId: null
      }))
      if (calls > 1) {
        return Promise.resolve(outcomes)
      }
      return new Promise<AgentSessionRestartOutcome[]>((resolve) => {
        gate.release = () => resolve(outcomes)
      })
    })
    const controller = createAgentSessionRestartController({
      plan: () =>
        planAgentSessionRestarts({
          enabledCatalog: ['claude'],
          panes: [pane(busy ? 'working' : 'done')]
        }),
      run
    })
    setAgentSessionRestartControllerForTests(controller)
    const stop = installAgentSessionRestartPromoter()
    try {
      const pending = controller.request('all')
      busy = false
      useAppStore.setState({
        agentStatusByPaneKey: { ...useAppStore.getState().agentStatusByPaneKey }
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      gate.release?.()
      await pending
      expect(run).toHaveBeenCalledTimes(2)
    } finally {
      stop()
      setAgentSessionRestartControllerForTests(null)
    }
  })
})
