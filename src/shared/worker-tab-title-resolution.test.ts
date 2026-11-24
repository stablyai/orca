import { describe, expect, it } from 'vitest'
import { resolveTerminalTabTitle } from './workspace-layout/tab-groups/tab-title-resolution'
import { observeWorkerTabAgentIdentity } from './orchestration/workers/worker-tab-agent-identity'
import type { WorkerTabStamp } from './orchestration/workers/worker-tab-stamp'

function worker(): WorkerTabStamp {
  return {
    origin: {
      runId: 'run',
      dispatchId: 'first',
      taskId: 'task',
      taskTitle: 'Original task',
      parent: { kind: 'pane', paneKey: 'coordinator' },
      coordinator: { kind: 'pane', paneKey: 'coordinator' }
    }
  }
}

describe('worker tab title ownership', () => {
  it('keeps the task title through identity enrichment, then follows a replacement session', () => {
    const stamp = worker()
    const tab = { title: 'New session work', workerTab: stamp }
    observeWorkerTabAgentIdentity(stamp, { agentType: 'codex' })
    observeWorkerTabAgentIdentity(stamp, { agentType: 'codex', providerSession: { id: 'first' } })
    expect(resolveTerminalTabTitle(tab, true)).toBe('Original task')
    observeWorkerTabAgentIdentity(stamp, { agentType: 'codex', providerSession: { id: 'second' } })
    expect(resolveTerminalTabTitle(tab, true)).toBe('New session work')
  })

  it('gives a different provider its live title while preserving a user rename', () => {
    const stamp = worker()
    observeWorkerTabAgentIdentity(stamp, { agentType: 'codex' })
    observeWorkerTabAgentIdentity(stamp, { agentType: 'claude' })
    expect(resolveTerminalTabTitle({ title: 'New provider work', workerTab: stamp }, true)).toBe(
      'New provider work'
    )
    expect(
      resolveTerminalTabTitle(
        { title: 'New provider work', workerTab: stamp, customTitle: 'My name' },
        true
      )
    ).toBe('My name')
  })
})
