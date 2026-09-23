import { describe, expect, it } from 'vitest'
import type { AgentSessionBackgroundTask } from './agent-session-background-task-wire'
import {
  agentChildWorkProjectionCandidateFromBackgroundTask,
  projectAgentChildWorkLegacySubagents
} from './agent-status-child-work-projection'
import { structuredAgentSessionAgentStatus } from './structured-agent-session-agent-status'

function task(over: Partial<AgentSessionBackgroundTask> = {}): AgentSessionBackgroundTask {
  return { id: 'task-1', kind: 'agent', state: 'working', ...over }
}

describe('structuredAgentSessionAgentStatus', () => {
  it('maps a lead that is still working or needs attention without consulting children', () => {
    expect(structuredAgentSessionAgentStatus({ status: 'working' })).toEqual({
      state: 'working',
      fromChildWork: false
    })
    expect(
      structuredAgentSessionAgentStatus({
        status: 'attention',
        backgroundTasks: [task({ kind: 'command' })]
      })
    ).toEqual({ state: 'blocked', fromChildWork: false })
  })

  it('keeps an idle lead working while a subagent runs', () => {
    expect(
      structuredAgentSessionAgentStatus({ status: 'idle', backgroundTasks: [task()] })
    ).toEqual({ state: 'working', fromChildWork: true })
  })

  it('reads an idle lead with only a backgrounded shell as monitoring', () => {
    expect(
      structuredAgentSessionAgentStatus({
        status: 'idle',
        backgroundTasks: [task({ kind: 'command', description: 'sleep 180' })]
      })
    ).toEqual({ state: 'working', workingMode: 'monitoring', fromChildWork: true })
  })

  it('keeps an idle lead working while a subagent is blocked or out of contact', () => {
    for (const state of ['waiting', 'blocked', 'unverifiable'] as const) {
      expect(
        structuredAgentSessionAgentStatus({ status: 'idle', backgroundTasks: [task({ state })] })
      ).toEqual({ state: 'working', fromChildWork: true })
    }
  })

  // Workflow agents never become roster children here, so the workflow row itself must hold the
  // lead working; it still projects no child the expanded row would have to show.
  it('reads a lead whose only live task is a workflow as working, with no children to show', () => {
    const backgroundTasks = [task({ id: 'flow-1', kind: 'workflow' })]
    expect(structuredAgentSessionAgentStatus({ status: 'idle', backgroundTasks })).toEqual({
      state: 'working',
      fromChildWork: true
    })
    expect(
      projectAgentChildWorkLegacySubagents(
        backgroundTasks.map(agentChildWorkProjectionCandidateFromBackgroundTask)
      )
    ).toBeUndefined()
  })

  it('reads an unknown live task as working, and only shells and monitors as monitoring', () => {
    expect(
      structuredAgentSessionAgentStatus({
        status: 'idle',
        backgroundTasks: [task({ id: 'shell', kind: 'command' }), task({ kind: 'unknown' })]
      })
    ).toEqual({ state: 'working', fromChildWork: true })
    expect(
      structuredAgentSessionAgentStatus({
        status: 'idle',
        backgroundTasks: [task({ id: 'shell', kind: 'command' }), task({ kind: 'monitor' })]
      })
    ).toEqual({ state: 'working', workingMode: 'monitoring', fromChildWork: true })
  })

  it('settles an idle lead once every task has settled', () => {
    expect(
      structuredAgentSessionAgentStatus({
        status: 'idle',
        backgroundTasks: [
          task({ state: 'done' }),
          task({ id: 'shell', kind: 'command', state: 'idle' })
        ]
      })
    ).toEqual({ state: 'done', fromChildWork: false })
    expect(structuredAgentSessionAgentStatus({ status: 'idle' })).toEqual({
      state: 'done',
      fromChildWork: false
    })
  })
})
