// Perf contract for #45032: a completion-only status restatement must not copy or scan the pop-out's cards.
import { describe, expect, it } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type {
  DashboardCard,
  DashboardSnapshot
} from '../../../../../shared/agent-status/presentation/dashboard-snapshot'
import { patchDashboardSnapshotFromAgentStatus } from './dashboard-agent-status-patch'

function countedSnapshot(size: number): {
  snapshot: DashboardSnapshot
  paneKeyReads: () => number
} {
  let reads = 0
  const cards = Array.from({ length: size }, (_, i): DashboardCard => {
    const card = {
      ptyId: null,
      agentType: 'claude',
      bucket: 'idle',
      dotState: 'done',
      task: 'task',
      repoId: 'repo',
      worktreeId: 'wt',
      tabId: `tab-${i}`,
      leafId: null,
      repoName: 'repo',
      worktreeName: 'wt',
      startedAt: 1_000,
      finishedAt: 2_000,
      stateChangedAt: 2_000,
      statusUpdatedAt: 2_000,
      unseen: false
    } as unknown as DashboardCard
    Object.defineProperty(card, 'paneKey', {
      enumerable: true,
      get: () => {
        reads += 1
        return `tab-${i}:leaf`
      }
    })
    return card
  })
  return {
    snapshot: { generatedAt: 2_000, cards } as unknown as DashboardSnapshot,
    paneKeyReads: () => reads
  }
}

function status(
  paneKey: string,
  receivedAt: number,
  state: 'done' | 'working'
): AgentStatusIpcPayload {
  return {
    paneKey,
    state,
    receivedAt,
    stateStartedAt: state === 'done' ? 2_000 : receivedAt,
    connectionId: null,
    worktreeId: 'wt'
  } as unknown as AgentStatusIpcPayload
}

describe('dashboard pop-out status patch work', () => {
  it.each([100, 1_000])('restates a finished card without copying or scanning %i cards', (size) => {
    const { snapshot, paneKeyReads } = countedSnapshot(size)
    // The pane index is built once per relayed snapshot.
    patchDashboardSnapshotFromAgentStatus(snapshot, status('tab-0:leaf', 3_000, 'done'))
    const before = paneKeyReads()

    const restated = patchDashboardSnapshotFromAgentStatus(
      snapshot,
      status('tab-7:leaf', 4_000, 'done')
    )

    expect(restated).toEqual({ matched: true, snapshot })
    expect(paneKeyReads() - before).toBe(1)
  })

  it.each([100, 1_000])('patches real changes by key across %i cards', (size) => {
    const { snapshot, paneKeyReads } = countedSnapshot(size)
    const first = patchDashboardSnapshotFromAgentStatus(
      snapshot,
      status('tab-3:leaf', 3_000, 'working')
    )
    const before = paneKeyReads()

    const second = patchDashboardSnapshotFromAgentStatus(
      first.snapshot,
      status('tab-9:leaf', 4_000, 'working')
    )

    expect(paneKeyReads() - before).toBe(1)
    expect(second.snapshot.cards[3].dotState).toBe('working')
    expect(second.snapshot.cards[9]).toMatchObject({ dotState: 'working', statusUpdatedAt: 4_000 })
    expect(second.snapshot.cards[8]).toBe(snapshot.cards[8])
  })
})
