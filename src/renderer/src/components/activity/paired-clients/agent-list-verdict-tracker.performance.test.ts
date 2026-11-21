import { expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import type { AgentPaneThread } from '../threads/activity-thread-types'
import { createAgentListVerdictTracker } from './agent-list-verdict-tracker'

// Perf contract: every agent step rebuilt and serialized the whole Agents list for paired phones
// (40 of 50 launch long tasks on a large fleet); one changed pane must cost the same at N and 10N.

let reads = 0

function counted<T extends object>(row: T): T {
  for (const [key, value] of Object.entries(row)) {
    Object.defineProperty(row, key, {
      enumerable: true,
      get: () => {
        reads++
        return value
      }
    })
  }
  return row
}

function entry(paneKey: string, state: 'working' | 'done', at: number): AgentStatusEntry {
  const coordinator = paneKey.endsWith('-worker') ? paneKey.replace('-worker', '') : null
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the verdict reads only these fields.
  return {
    paneKey,
    state,
    stateStartedAt: at,
    updatedAt: at,
    // Two coordinators report one handle, as a pane whose terminal moved keeps its old history.
    terminalHandle: paneKey === 'pane-1' || paneKey === 'pane-2' ? 'term-moved' : `term-${paneKey}`,
    ...(coordinator ? { orchestration: { parentPaneKey: coordinator } } : {})
  } as unknown as AgentStatusEntry
}

function thread(paneKey: string, state: 'working' | 'done', at: number): AgentPaneThread {
  const current = entry(paneKey, state, at)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the verdict and child classifier read only these fields.
  return counted({
    paneKey,
    paneTitle: paneKey,
    currentAgentState: state === 'working' ? 'working' : null,
    currentAgentEntry: state === 'working' ? current : null,
    paneEntry: current,
    latestTimestamp: at,
    latestEvent: { entry: current },
    events: [{ entry: current }],
    unread: false
  } as unknown as AgentPaneThread)
}

/** Field reads to publish one worker's step on `agents` coordinators, each with a worker, two sharing a handle. */
function readsForOneStep(agents: number): number {
  const threads = new Map<string, AgentPaneThread>()
  const statuses = new Map<string, AgentStatusEntry>()
  for (let index = 0; index < agents; index++) {
    for (const paneKey of [`pane-${index}`, `pane-${index}-worker`]) {
      threads.set(paneKey, thread(paneKey, 'working', index))
      statuses.set(paneKey, entry(paneKey, 'working', index))
    }
  }
  const tracker = createAgentListVerdictTracker()
  const sources = () => ({
    threads: [...threads.values()],
    thread: (paneKey: string) => threads.get(paneKey),
    statuses,
    acknowledgedAt: {}
  })
  tracker.collect(sources())

  const stepped = 'pane-0-worker'
  threads.set(stepped, thread(stepped, 'done', agents + 1))
  statuses.set(stepped, entry(stepped, 'done', agents + 1))
  const current = sources()
  reads = 0
  tracker.markPanes([stepped])
  const changes = tracker.collect(current)
  expect(Object.keys(changes.changed)).toEqual([stepped])
  expect(changes.changed[stepped]).toMatchObject({ childOf: 'pane-0', foldedChild: true })
  return reads
}

it('publishes one agent step with the same work at N and 10N agents', () => {
  const small = readsForOneStep(100)
  const large = readsForOneStep(1000)
  expect(small).toBeGreaterThan(0)
  expect(large).toBe(small)
})
