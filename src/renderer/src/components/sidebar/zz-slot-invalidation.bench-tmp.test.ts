import { it } from 'vitest'
import { appendFileSync } from 'node:fs'
import type { AppState } from '@/store/types'
import { changedSlotWorkspaces, type SlotSnapshot } from './worktree-card-slot-invalidation'

function snap(
  live: Record<string, unknown>,
  acks: Record<string, unknown>,
  epoch: number
): SlotSnapshot {
  const layout = {
    tabsByWorktree: {},
    unifiedTabsByWorktree: {},
    migrationUnsupportedByPtyId: {},
    retainedAgentsByPaneKey: {},
    ptyIdsByTabId: {},
    terminalLayoutsByTabId: {},
    runtimeAgentOrchestrationByPaneKey: {},
    paneForegroundAgentByPaneKey: {}
  }
  return {
    inputs: [],
    layout,
    orchestration: new Map(),
    worktreesByRepo: {},
    owner: [],
    live,
    acknowledgements: acks,
    titles: {},
    epoch,
    at: 2_000_000
  } as unknown as SlotSnapshot
}

it.each([100, 1000, 10000])('live diff cost with %i panes', (n) => {
  const live: Record<string, unknown> = {}
  const acks: Record<string, unknown> = {}
  for (let i = 0; i < n; i++) {
    live[`tab${i}:leaf`] = { worktreeId: `w${i}`, updatedAt: 2_000_000, state: 'working' }
    acks[`tab${i}:leaf`] = { at: 1 }
  }
  const state = { tabsByWorktree: {}, unifiedTabsByWorktree: {} } as unknown as AppState
  const results: string[] = []
  for (const [label, mk] of [
    [
      'one live entry',
      (prev: SlotSnapshot) =>
        snap(
          {
            ...prev.live,
            'tab0:leaf': { worktreeId: 'w0', updatedAt: 2_000_001, state: 'working' }
          },
          prev.acknowledgements,
          prev.epoch
        )
    ],
    ['epoch bump', (prev: SlotSnapshot) => snap(prev.live, prev.acknowledgements, prev.epoch + 1)],
    [
      'one ack',
      (prev: SlotSnapshot) =>
        snap(prev.live, { ...prev.acknowledgements, 'tab0:leaf': { at: 2 } }, prev.epoch)
    ]
  ] as const) {
    const runs: number[] = []
    for (let r = 0; r < 50; r++) {
      const before = snap(live, acks, 1)
      const after = mk(before)
      const t = performance.now()
      changedSlotWorkspaces(state, before, after)
      runs.push(performance.now() - t)
    }
    runs.sort((a, b) => a - b)
    results.push(`${label}: median ${runs[25]!.toFixed(3)}ms p95 ${runs[47]!.toFixed(3)}ms`)
  }
  appendFileSync(
    '/private/tmp/claude-501/-Users-jinjingliang-Documents-projects-orca-new-worktree-sidebar/891ff09f-c478-44b2-94a1-7e1df9183934/scratchpad/bench.txt',
    `n=${n}\n  ${results.join('\n  ')}\n`
  )
})
