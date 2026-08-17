import { describe, expect, it } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status-types'
import type { DashboardCard, DashboardSnapshot } from '../../../../shared/dashboard-snapshot'
import { ORCA_DISPATCH_PREAMBLE_PREFIX } from '@/lib/agent-row-primary-text'
import { deriveAgentMapLayout } from './agent-map-layout'
import { patchDashboardSnapshotFromAgentStatus } from './dashboard-agent-status-patch'

function card(overrides: Partial<DashboardCard> = {}): DashboardCard {
  return {
    paneKey: 'tab-1:leaf-1',
    ptyId: 'pty-1',
    agentType: 'codex',
    bucket: 'working',
    dotState: 'working',
    task: 'old task',
    repoId: 'repo-1',
    worktreeId: 'worktree-1',
    tabId: 'tab-1',
    leafId: 'leaf-1',
    repoName: 'Repo',
    worktreeName: 'Worktree',
    startedAt: 100,
    finishedAt: null,
    stateChangedAt: 100,
    statusUpdatedAt: 150,
    unseen: false,
    ...overrides
  }
}

function event(overrides: Partial<AgentStatusIpcPayload> = {}): AgentStatusIpcPayload {
  return {
    paneKey: 'tab-1:leaf-1',
    state: 'blocked',
    prompt: 'Need a decision',
    connectionId: null,
    receivedAt: 300,
    stateStartedAt: 250,
    interactivePrompt: '{"question":"Continue?"}',
    ...overrides
  }
}

function snapshot(cards: DashboardCard[] = [card()]): DashboardSnapshot {
  return { generatedAt: 200, cards }
}

function dispatchPrompt(taskId: string, task: string): string {
  return `${ORCA_DISPATCH_PREAMBLE_PREFIX}\nYour task ID is: ${taskId}\n=== TASK ===\n${task}`
}

describe('patchDashboardSnapshotFromAgentStatus', () => {
  it('patches one known card without rebuilding the dashboard topology', () => {
    const original = snapshot([card(), card({ paneKey: 'tab-2:leaf-2' })])
    const result = patchDashboardSnapshotFromAgentStatus(original, event())

    expect(result.matched).toBe(true)
    expect(result.snapshot.cards[0]).toMatchObject({
      bucket: 'attention',
      dotState: 'blocked',
      task: 'Need a decision',
      lastUserMessage: 'Need a decision',
      askSummary: '{"question":"Continue?"}',
      stateChangedAt: 250,
      statusUpdatedAt: 300,
      unseen: true
    })
    expect(result.snapshot.cards[1]).toBe(original.cards[1])
  })

  it('patches matching orchestration identity separately from task text', () => {
    const prompt = dispatchPrompt('task-1', 'Raw dispatched task')
    const result = patchDashboardSnapshotFromAgentStatus(
      snapshot(),
      event({
        prompt,
        orchestration: {
          taskId: 'task-1',
          dispatchId: 'dispatch-1',
          dispatchStatus: 'dispatched',
          displayName: 'Readable worker name',
          taskTitle: 'Readable task title',
          parentPaneKey: 'tab-parent:leaf-parent'
        }
      })
    )

    expect(result.snapshot.cards[0]).toMatchObject({
      task: 'Readable task title',
      orchestrationDisplayName: 'Readable worker name',
      lastUserMessage: prompt,
      parentPaneKey: 'tab-parent:leaf-parent'
    })
  })

  it('keeps active pane lineage on hook pings that omit the cached prompt', () => {
    const result = patchDashboardSnapshotFromAgentStatus(
      snapshot(),
      event({
        prompt: '',
        orchestration: {
          taskId: 'task-1',
          dispatchId: 'dispatch-1',
          dispatchStatus: 'dispatched',
          parentPaneKey: 'tab-parent:leaf-parent'
        }
      })
    )

    expect(result.snapshot.cards[0].parentPaneKey).toBe('tab-parent:leaf-parent')
  })

  it('accepts matching mixed-version lineage when dispatch status is omitted', () => {
    const result = patchDashboardSnapshotFromAgentStatus(
      snapshot(),
      event({
        prompt: dispatchPrompt('task-1', 'Current task'),
        orchestration: {
          taskId: 'task-1',
          dispatchId: 'dispatch-1',
          parentPaneKey: 'tab-parent:leaf-parent'
        }
      })
    )

    expect(result.snapshot.cards[0].parentPaneKey).toBe('tab-parent:leaf-parent')
  })

  it('clears stale task and identity when a legacy dispatch has no task body', () => {
    const prompt = `${ORCA_DISPATCH_PREAMBLE_PREFIX}\nYour task ID is: legacy-task`
    const result = patchDashboardSnapshotFromAgentStatus(
      snapshot([card({ orchestrationDisplayName: 'old identity' })]),
      event({ prompt })
    )

    expect(result.snapshot.cards[0]).toMatchObject({
      task: '',
      lastUserMessage: prompt
    })
    expect(result.snapshot.cards[0].orchestrationDisplayName).toBeUndefined()
  })

  it.each([
    ['working', 'Standalone task'],
    ['done', 'Standalone task'],
    ['working', dispatchPrompt('task-new', 'New dispatched task')],
    ['done', dispatchPrompt('task-old', 'Settled dispatched task')]
  ] as const)('clears stale settled pane lineage from a reused %s turn', (state, prompt) => {
    const result = patchDashboardSnapshotFromAgentStatus(
      snapshot([
        card({
          parentPaneKey: 'tab-parent:leaf-parent',
          parentWorktreeId: 'parent-worktree'
        })
      ]),
      event({
        state,
        prompt,
        orchestration: {
          taskId: 'task-old',
          dispatchId: 'dispatch-old',
          dispatchStatus: 'completed',
          parentPaneKey: 'tab-parent:leaf-parent'
        }
      })
    )

    expect(result.snapshot.cards[0].parentPaneKey).toBeUndefined()
    expect(result.snapshot.cards[0].parentWorktreeId).toBe('parent-worktree')
  })

  it('keeps card-only workspace lineage after clearing stale pane lineage', () => {
    const result = patchDashboardSnapshotFromAgentStatus(
      snapshot([
        card({
          paneKey: 'tab-parent:leaf-parent',
          worktreeId: 'parent-worktree',
          worktreeName: 'Parent worktree'
        }),
        card({
          paneKey: 'tab-child:leaf-child',
          worktreeId: 'child-worktree',
          worktreeName: 'Child worktree',
          parentPaneKey: 'tab-parent:leaf-parent',
          parentWorktreeId: 'parent-worktree'
        })
      ]),
      event({
        paneKey: 'tab-child:leaf-child',
        state: 'working',
        prompt: 'Standalone task',
        orchestration: {
          taskId: 'task-old',
          dispatchId: 'dispatch-old',
          dispatchStatus: 'completed',
          parentPaneKey: 'tab-parent:leaf-parent'
        }
      })
    )

    expect(result.snapshot.workspaces).toBeUndefined()
    const project = deriveAgentMapLayout(result.snapshot.cards, 400).projects[0]
    const parent = project.worktrees.find((worktree) => worktree.worktreeId === 'parent-worktree')!
    const child = project.worktrees.find((worktree) => worktree.worktreeId === 'child-worktree')!
    expect(child.parentId).toBe(parent.id)
    expect(child.y).toBeGreaterThan(parent.y)
  })

  it('clears standalone completed pane grouping but preserves workspace lineage', () => {
    const completed = patchDashboardSnapshotFromAgentStatus(
      snapshot([
        card({
          parentPaneKey: 'tab-parent:leaf-parent',
          parentWorktreeId: 'parent-worktree'
        })
      ]),
      event({ state: 'done', orchestration: undefined })
    ).snapshot.cards[0]
    const working = patchDashboardSnapshotFromAgentStatus(
      snapshot(),
      event({ state: 'working', orchestration: undefined })
    ).snapshot.cards[0]

    expect(completed.parentPaneKey).toBeUndefined()
    expect(completed.parentWorktreeId).toBe('parent-worktree')
    expect(working.parentPaneKey).toBeUndefined()
    expect(working.parentWorktreeId).toBeUndefined()
  })

  it('preserves cached fields omitted from same-state hook pings', () => {
    const original = snapshot([
      card({
        bucket: 'attention',
        dotState: 'waiting',
        askSummary: 'Pick one',
        lastAgentMessage: 'Waiting',
        stateChangedAt: 250,
        unseen: true
      })
    ])
    const result = patchDashboardSnapshotFromAgentStatus(
      original,
      event({ state: 'waiting', prompt: '', interactivePrompt: undefined, stateStartedAt: 250 })
    )

    expect(result.snapshot.cards[0]).toMatchObject({
      task: 'old task',
      askSummary: 'Pick one',
      lastAgentMessage: 'Waiting',
      unseen: true
    })
  })

  it('ignores stale, wrong-workspace, and session-only events', () => {
    const original = snapshot()
    expect(
      patchDashboardSnapshotFromAgentStatus(original, event({ receivedAt: 150 })).snapshot
    ).toBe(original)
    expect(
      patchDashboardSnapshotFromAgentStatus(original, event({ worktreeId: 'other' })).snapshot
    ).toBe(original)
    expect(
      patchDashboardSnapshotFromAgentStatus(original, event({ providerSessionOnly: true })).snapshot
    ).toBe(original)
  })

  it('asks the caller for topology only when the pane is unknown', () => {
    const original = snapshot()
    const result = patchDashboardSnapshotFromAgentStatus(
      original,
      event({ paneKey: 'tab-new:leaf-new' })
    )

    expect(result).toEqual({ matched: false, snapshot: original })
  })
})
