// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type MockStore = {
  orchestrators: { worktreeId: string; projectName?: string }[]
  worktreeLineageById: Record<string, unknown>
  worktreesByRepo: Record<
    string,
    { id: string; repoId: string; branch?: string; displayName?: string; path?: string }[]
  >
  tabsByWorktree: Record<string, { id: string }[]>
  agentStatusByPaneKey: Record<string, unknown>
  orchestrationActivityByPaneKey: Record<string, unknown>
  orchestrationRunDagByPaneKey: Record<string, unknown>
  repos: { id: string; path: string; connectionId?: string }[]
  settings: Record<string, unknown>
  hostedReviewCache: Record<string, unknown>
}

const harness = vi.hoisted(() => ({
  store: {} as MockStore
}))

vi.mock('@/store', () => ({
  useAppStore: <T,>(selector: (s: MockStore) => T): T => selector(harness.store)
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('./MissionControlTasksSection', () => ({
  MissionControlTasksSection: () => <div data-testid="tasks-section" />
}))

// Why: the card renders its compact header; surfacing `headerLeft` lets us assert
// the live activity line the lineage row injects without mounting the heavy
// Checks panel.
vi.mock('./MissionControlPrReviewCard', () => ({
  MissionControlPrReviewCard: (props: { headerLeft?: React.ReactNode }) => (
    <div data-testid="pr-card">{props.headerLeft}</div>
  )
}))

vi.mock('./MissionControlPrStatePill', () => ({ PrStatePill: () => <span /> }))

vi.mock('@/lib/orcastrate-log-shipped-work', () => ({
  parseOrchestrateLogOutcomes: () => [],
  selectShippedWork: () => []
}))

import OrchestratorMissionControl from './OrchestratorMissionControl'

function baseStore(): MockStore {
  return {
    orchestrators: [{ worktreeId: 'wt_director', projectName: 'Auth rewrite' }],
    // One spawned worker whose lineage parent is the director.
    worktreeLineageById: {
      wt_worker: { worktreeId: 'wt_worker', parentWorktreeId: 'wt_director', createdAt: 1 }
    },
    worktreesByRepo: {
      repo1: [
        { id: 'wt_director', repoId: 'repo1', path: '/d', branch: 'main' },
        { id: 'wt_worker', repoId: 'repo1', path: '/w', branch: 'feat/x', displayName: 'worker-1' }
      ]
    },
    tabsByWorktree: { wt_director: [{ id: 'tab_a' }], wt_worker: [{ id: 'tab_w' }] },
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

describe('OrchestratorMissionControl — Spawned work activity line', () => {
  it("renders the worker's live agent activity text under its name", async () => {
    harness.store.agentStatusByPaneKey = {
      'tab_w:leaf': {
        state: 'working',
        prompt: 'Refactoring the auth module',
        stateStartedAt: 100
      }
    }
    await renderPanel()
    expect(container.textContent).toContain('worker-1')
    expect(container.textContent).toContain('Refactoring the auth module')
  })

  it('falls back to the state label when the live agent reported no prompt', async () => {
    harness.store.agentStatusByPaneKey = {
      'tab_w:leaf': { state: 'working', prompt: '', stateStartedAt: 100 }
    }
    await renderPanel()
    expect(container.textContent).toContain('worker-1')
    expect(container.textContent).toContain('Working')
  })

  it('omits the activity line when no agent has reported for the worker', async () => {
    await renderPanel()
    expect(container.textContent).toContain('worker-1')
    // No live entry → no activity text (and no state-label fallback) on the row.
    expect(container.textContent).not.toContain('Working')
  })
})
