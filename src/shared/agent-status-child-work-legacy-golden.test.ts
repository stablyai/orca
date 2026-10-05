import { describe, expect, it } from 'vitest'
import type { AgentSessionBackgroundTask } from './agent-session-background-task-wire'
import {
  agentChildWorkProjectionCandidateFromBackgroundTask,
  projectAgentChildWorkLegacyBackgroundTasks,
  projectAgentChildWorkLegacySubagents
} from './agent-status-child-work-projection'

// Today's inputs: the rows a host publishes on `summary.backgroundTasks`, run through the exact
// path the status bridge uses. The expected values were captured on unmodified main.
const PUBLISHED_TASKS: AgentSessionBackgroundTask[] = [
  {
    id: 'task-agent',
    kind: 'agent',
    state: 'working',
    name: 'researcher',
    description: 'Investigate',
    startedAt: 100,
    totalTokens: 12,
    stoppable: true
  },
  { id: 'task-agent-no-state', kind: 'agent', name: 'planner', startedAt: 110 },
  {
    id: 'task-agent-monitoring',
    kind: 'agent',
    state: 'monitoring',
    description: 'Watch',
    startedAt: 120,
    stoppable: false
  },
  { id: 'task-agent-waiting', kind: 'agent', state: 'waiting', startedAt: 130 },
  {
    id: 'task-agent-blocked',
    kind: 'agent',
    state: 'blocked',
    name: '',
    description: '',
    startedAt: 140
  },
  { id: 'task-agent-done', kind: 'agent', state: 'done', startedAt: 150 },
  { id: 'task-agent-idle', kind: 'agent', state: 'idle', startedAt: 160 },
  { id: 'task-agent-unverifiable', kind: 'agent', state: 'unverifiable', startedAt: 170 },
  { id: 'task-agent-no-start', kind: 'agent', state: 'working' },
  { id: '  padded-agent  ', kind: 'agent', state: 'working', startedAt: 180 },
  { id: 'x'.repeat(65), kind: 'agent', state: 'working', startedAt: 190 },
  { id: 'task-shell', kind: 'command', state: 'working', description: 'npm test', startedAt: 200 },
  {
    id: 'task-monitor',
    kind: 'monitor',
    state: 'monitoring',
    description: 'tail log',
    startedAt: 210
  },
  { id: 'task-workflow', kind: 'workflow', startedAt: 220 },
  { id: 'task-unknown', kind: 'unknown', state: 'blocked', startedAt: 230 }
]

describe('legacy child-work projection of published background tasks', () => {
  it('derives the sidebar subagents exactly as the status bridge does today', () => {
    const golden = projectAgentChildWorkLegacySubagents(
      PUBLISHED_TASKS.map(agentChildWorkProjectionCandidateFromBackgroundTask)
    )
    expect(JSON.stringify(golden)).toMatchInlineSnapshot(
      `"[{"id":"task-agent","state":"working","startedAt":100,"agentType":"researcher","description":"Investigate"},{"id":"task-agent-no-state","state":"working","startedAt":110,"agentType":"planner"},{"id":"task-agent-monitoring","state":"working","startedAt":120,"description":"Watch"},{"id":"task-agent-waiting","state":"waiting","startedAt":130},{"id":"task-agent-blocked","state":"blocked","startedAt":140},{"id":"task-agent-done","state":"idle","startedAt":150},{"id":"task-agent-idle","state":"idle","startedAt":160},{"id":"task-agent-unverifiable","state":"unverifiable","startedAt":170},{"id":"task-agent-no-start","state":"working","startedAt":0},{"id":"padded-agent","state":"working","startedAt":180}]"`
    )
  })

  it('derives the live and settled background lists exactly as today', () => {
    const golden = projectAgentChildWorkLegacyBackgroundTasks(
      PUBLISHED_TASKS.map(agentChildWorkProjectionCandidateFromBackgroundTask)
    )
    expect(JSON.stringify(golden)).toMatchInlineSnapshot(
      `"{"tasks":[{"id":"task-agent","kind":"agent","description":"Investigate","name":"researcher","state":"working","startedAt":100,"totalTokens":12,"stoppable":true},{"id":"task-agent-no-state","kind":"agent","name":"planner","startedAt":110,"stoppable":true},{"id":"task-agent-monitoring","kind":"agent","description":"Watch","state":"monitoring","startedAt":120,"stoppable":false},{"id":"task-agent-waiting","kind":"agent","state":"waiting","startedAt":130,"stoppable":true},{"id":"task-agent-blocked","kind":"agent","state":"blocked","startedAt":140,"stoppable":true},{"id":"task-agent-done","kind":"agent","state":"done","startedAt":150,"stoppable":true},{"id":"task-agent-idle","kind":"agent","state":"idle","startedAt":160,"stoppable":true},{"id":"task-agent-unverifiable","kind":"agent","state":"unverifiable","startedAt":170,"stoppable":true},{"id":"task-agent-no-start","kind":"agent","state":"working","startedAt":0,"stoppable":true},{"id":"padded-agent","kind":"agent","state":"working","startedAt":180,"stoppable":true},{"id":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx","kind":"agent","state":"working","startedAt":190,"stoppable":true},{"id":"task-shell","kind":"command","description":"npm test","state":"working","startedAt":200,"stoppable":true},{"id":"task-monitor","kind":"monitor","description":"tail log","state":"monitoring","startedAt":210,"stoppable":true},{"id":"task-workflow","kind":"workflow","startedAt":220,"stoppable":true},{"id":"task-unknown","kind":"unknown","state":"blocked","startedAt":230,"stoppable":true}]}"`
    )
  })
})
