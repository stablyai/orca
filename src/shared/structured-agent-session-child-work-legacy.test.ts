// What a client that predates child views reads of a Codex child agent that launched a shell: the
// flat roster it always read, derived from the host's views.

import { describe, expect, it } from 'vitest'
import type { AgentChildWorkView } from './agent-status-child-work-view'
import { structuredChildWorkLegacyTasks } from './structured-agent-session-child-work-legacy'

const invocation = { invocationId: 'spawn', generation: 1 }
const reviewer: AgentChildWorkView = {
  id: 'child-agent',
  providerId: 'thread-A',
  kind: 'agent',
  description: 'reviewer',
  state: 'working',
  membership: 'live',
  firstObservedAt: 1,
  observedAt: 5,
  stoppable: false,
  invocation
}
const shell: AgentChildWorkView = {
  id: 'child-shell',
  providerId: 'cmd-1',
  kind: 'command',
  description: 'npm test --watch',
  parentChildWorkId: 'child-agent',
  state: 'working',
  membership: 'live',
  firstObservedAt: 2,
  observedAt: 5,
  stoppable: false,
  invocation
}
const lead: AgentChildWorkView = {
  ...shell,
  id: 'lead-shell',
  providerId: 'cmd-0',
  description: 'ls'
}
const { parentChildWorkId: _owner, ...leadShell } = lead

function rows(views: AgentChildWorkView[]) {
  const { tasks, settledTasks } = structuredChildWorkLegacyTasks(views, 'codex')
  const row = ({ id, description }: { id: string; description?: string }) => `${id}: ${description}`
  return { tasks: tasks?.map(row), settledTasks: settledTasks?.map(row) }
}

describe("a Codex child agent's shell on an older client's flat roster", () => {
  it('is hidden while its agent runs: the agent row stands for it', () => {
    expect(rows([reviewer, shell, leadShell])).toEqual({
      tasks: ['codex-agent:thread-A: reviewer', 'cmd-0: ls'],
      settledTasks: undefined
    })
  })

  it('names its agent once the agent has finished', () => {
    const finished: AgentChildWorkView = {
      ...reviewer,
      state: 'done',
      membership: 'settled',
      outcome: 'succeeded',
      settledAt: 6
    }
    expect(rows([finished, shell])).toEqual({
      tasks: ['cmd-1: reviewer — npm test --watch'],
      settledTasks: ['codex-agent:thread-A: reviewer']
    })
  })

  it('leaves another provider’s owned commands as they are', () => {
    const { tasks } = structuredChildWorkLegacyTasks([reviewer, shell], 'claude')
    expect(tasks?.map((task) => task.id)).toEqual(['thread-A', 'cmd-1'])
  })
})
