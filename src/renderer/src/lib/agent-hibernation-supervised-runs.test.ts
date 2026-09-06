import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import {
  getSupervisorLeafIdsWithUnsettledDispatch,
  isSupervisingUnsettledDispatch
} from './agent-hibernation-supervised-runs'

const COORDINATOR_LEAF = '33333333-3333-4333-8333-333333333333'
const COORDINATOR_PANE = `tab-coord:${COORDINATOR_LEAF}`

function worker(
  dispatchStatus: AgentStatusEntry['orchestration'] extends infer T
    ? T extends { dispatchStatus?: infer S }
      ? S
      : never
    : never,
  parentPaneKey: string | null = COORDINATOR_PANE
): AgentStatusEntry {
  return {
    paneKey: 'tab-worker:leaf-worker',
    state: 'working',
    orchestration: {
      taskId: 'task-1',
      dispatchId: 'ctx-1',
      dispatchStatus,
      ...(parentPaneKey ? { parentPaneKey } : {})
    }
  } as unknown as AgentStatusEntry
}

describe('supervisors with unsettled dispatches', () => {
  it.each(['pending', 'dispatched'] as const)('collects a supervisor of a %s worker', (status) => {
    const supervisors = getSupervisorLeafIdsWithUnsettledDispatch({ w: worker(status) })
    expect(isSupervisingUnsettledDispatch(COORDINATOR_PANE, supervisors)).toBe(true)
  })

  it.each(['completed', 'failed', 'circuit_broken'] as const)('ignores a %s worker', (status) => {
    const supervisors = getSupervisorLeafIdsWithUnsettledDispatch({ w: worker(status) })
    expect(isSupervisingUnsettledDispatch(COORDINATOR_PANE, supervisors)).toBe(false)
  })

  it('matches a supervisor whose tab was reminted', () => {
    const supervisors = getSupervisorLeafIdsWithUnsettledDispatch({ w: worker('dispatched') })
    expect(isSupervisingUnsettledDispatch(`tab-new:${COORDINATOR_LEAF}`, supervisors)).toBe(true)
  })

  it('ignores a worker whose supervisor pane is unknown', () => {
    expect(getSupervisorLeafIdsWithUnsettledDispatch({ w: worker('dispatched', null) }).size).toBe(
      0
    )
  })

  it('ignores entries with no orchestration context', () => {
    expect(
      getSupervisorLeafIdsWithUnsettledDispatch({
        a: { paneKey: 'tab:leaf', state: 'done' } as unknown as AgentStatusEntry,
        b: undefined
      }).size
    ).toBe(0)
  })
})
