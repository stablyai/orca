// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrchestrationRunDag, OrchestrationActivity } from '../../../../shared/runtime-types'

type MockStore = {
  orchestrators: { worktreeId: string; projectName?: string }[]
  worktreeLineageById: Record<string, unknown>
  worktreesByRepo: Record<
    string,
    { id: string; repoId: string; branch?: string; displayName?: string; path?: string }[]
  >
  tabsByWorktree: Record<string, { id: string }[]>
  agentStatusByPaneKey: Record<string, unknown>
  orchestrationActivityByPaneKey: Record<string, OrchestrationActivity>
  orchestrationRunDagByPaneKey: Record<string, OrchestrationRunDag>
  repos: { id: string; path: string; connectionId?: string }[]
  settings: Record<string, unknown>
  hostedReviewCache: Record<string, unknown>
}

const harness = vi.hoisted(() => ({
  store: {} as MockStore,
  shipped: [] as { name: string }[]
}))

vi.mock('@/store', () => ({
  useAppStore: <T,>(selector: (s: MockStore) => T): T => selector(harness.store)
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    values
      ? fallback
          .replace('{{value0}}', String(values.value0))
          .replace('{{value1}}', String(values.value1))
          .replace('{{value2}}', String(values.value2))
      : fallback
}))

// Why: the live DAG section is unit-tested on its own; here we only assert the
// parent renders it (vs the lineage fallback), so a marker keeps the test focused.
vi.mock('./MissionControlTasksSection', () => ({
  MissionControlTasksSection: () => <div data-testid="tasks-section" />
}))

vi.mock('./MissionControlPrReviewCard', () => ({
  MissionControlPrReviewCard: (props: { headerLeft?: React.ReactNode }) => (
    <div data-testid="pr-card">{props.headerLeft}</div>
  )
}))

vi.mock('./MissionControlPrStatePill', () => ({ PrStatePill: () => <span /> }))

vi.mock('@/lib/orcastrate-log-shipped-work', () => ({
  parseOrchestrateLogOutcomes: () => [],
  selectShippedWork: () => harness.shipped
}))

import OrchestratorMissionControl from './OrchestratorMissionControl'

function dag(): OrchestrationRunDag {
  return { runId: 'run_1', recipe: null, tasks: [], truncatedTaskCount: 0 }
}

function baseStore(): MockStore {
  return {
    orchestrators: [{ worktreeId: 'wt_director', projectName: 'Auth rewrite' }],
    worktreeLineageById: {},
    worktreesByRepo: {
      repo1: [{ id: 'wt_director', repoId: 'repo1', path: '/d', branch: 'main' }]
    },
    tabsByWorktree: { wt_director: [{ id: 'tab_a' }] },
    agentStatusByPaneKey: {},
    orchestrationActivityByPaneKey: {},
    orchestrationRunDagByPaneKey: {},
    repos: [{ id: 'repo1', path: '/repo' }],
    settings: {},
    hostedReviewCache: {}
  }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  harness.store = baseStore()
  harness.shipped = []
  // Stub the IPC surface the component's effects reach for.
  ;(globalThis as unknown as { window: { api: unknown } }).window.api = {
    fs: { readFile: () => Promise.resolve({ content: '' }) },
    gh: {
      repoSlug: () => Promise.resolve(null),
      listWorkItems: () => Promise.resolve({ items: [] })
    },
    shell: { openUrl: () => Promise.resolve() }
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function renderPanel(): Promise<void> {
  await act(async () => {
    root.render(<OrchestratorMissionControl worktreeId="wt_director" />)
  })
}

describe('OrchestratorMissionControl — DAG vs lineage', () => {
  it('renders the live task DAG + supervision counts when a coordinator run exists', async () => {
    harness.store.orchestrationRunDagByPaneKey = { 'tab_a:leaf': dag() }
    harness.store.orchestrationActivityByPaneKey = {
      'tab_a:leaf': { runId: 'run_1', pendingTasks: 3, activeDispatches: 2, staleDispatches: 1 }
    }
    await renderPanel()
    expect(container.querySelector('[data-testid="tasks-section"]')).not.toBeNull()
    // Counts line from OrchestrationActivity (#5: pendingTasks labeled "outstanding").
    expect(container.textContent).toContain('3 outstanding · 2 workers · 1 stalled')
    // The lineage "Spawned work" section is replaced, not shown.
    expect(container.textContent).not.toContain('Spawned work')
  })

  it('falls back to the lineage view when the director has no coordinator run', async () => {
    await renderPanel()
    expect(container.querySelector('[data-testid="tasks-section"]')).toBeNull()
    expect(container.textContent).toContain('Spawned work')
  })

  it('still renders the Shipped section alongside the fallback view', async () => {
    harness.shipped = [{ name: 'feat/x' }]
    await renderPanel()
    expect(container.textContent).toContain('Shipped')
  })
})
