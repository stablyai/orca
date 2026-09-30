// @vitest-environment happy-dom

import { Profiler } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestStore } from '../slices/store-test-helpers'

afterEach(cleanup)

type TestStore = ReturnType<typeof createTestStore>

const TAB_ID = 'tab-1'
const NO_OP_WRITES = 25

function recordPublishedMapKeys(store: TestStore): string[] {
  const published: string[] = []
  store.subscribe((next, previous) => {
    if (next.expandedPaneByTabId !== previous.expandedPaneByTabId) {
      published.push('expandedPaneByTabId')
    }
    if (next.canExpandPaneByTabId !== previous.canExpandPaneByTabId) {
      published.push('canExpandPaneByTabId')
    }
  })
  return published
}

// Mirrors use-terminal-workspace-store-bindings.ts:17, which subscribes to the raw map.
function ExpandedPaneSubscriber({ store }: { store: TestStore }): React.JSX.Element {
  const expandedPaneByTabId = store((s) => s.expandedPaneByTabId)
  return <span>{String(expandedPaneByTabId[TAB_ID] === true)}</span>
}

function CanExpandPaneSubscriber({ store }: { store: TestStore }): React.JSX.Element {
  const canExpandPaneByTabId = store((s) => s.canExpandPaneByTabId)
  return <span>{String(canExpandPaneByTabId[TAB_ID] === true)}</span>
}

function renderCommitCounter(subscriber: React.JSX.Element): () => number {
  let commits = 0
  render(
    <Profiler
      id="terminal-pane-expansion"
      onRender={() => {
        commits += 1
      }}
    >
      {subscriber}
    </Profiler>
  )
  const mountCommits = commits
  return () => commits - mountCommits
}

describe('setTabPaneExpanded', () => {
  it('publishes the first write for an unseen tab and a real toggle', () => {
    const store = createTestStore()
    const published = recordPublishedMapKeys(store)

    store.getState().setTabPaneExpanded(TAB_ID, false)
    expect(published).toEqual(['expandedPaneByTabId'])
    expect(store.getState().expandedPaneByTabId[TAB_ID]).toBe(false)

    store.getState().setTabPaneExpanded(TAB_ID, true)
    expect(published).toEqual(['expandedPaneByTabId', 'expandedPaneByTabId'])
    expect(store.getState().expandedPaneByTabId[TAB_ID]).toBe(true)
  })

  it('bails out when the value is unchanged', () => {
    const store = createTestStore()
    store.getState().setTabPaneExpanded(TAB_ID, false)
    const before = store.getState().expandedPaneByTabId
    // Root identity too: returning `{}` keeps the map but allocates a new root, so zustand still walks every listener.
    const rootBefore = store.getState()
    const published = recordPublishedMapKeys(store)

    for (let i = 0; i < NO_OP_WRITES; i += 1) {
      store.getState().setTabPaneExpanded(TAB_ID, false)
    }

    expect(published).toEqual([])
    expect(store.getState().expandedPaneByTabId).toBe(before)
    expect(store.getState()).toBe(rootBefore)
  })

  it('costs no React commit in a map subscriber when the value is unchanged', () => {
    const store = createTestStore()
    store.getState().setTabPaneExpanded(TAB_ID, false)
    const commitsSinceMount = renderCommitCounter(<ExpandedPaneSubscriber store={store} />)

    for (let i = 0; i < NO_OP_WRITES; i += 1) {
      act(() => {
        store.getState().setTabPaneExpanded(TAB_ID, false)
      })
    }
    expect(commitsSinceMount()).toBe(0)

    act(() => {
      store.getState().setTabPaneExpanded(TAB_ID, true)
    })
    expect(commitsSinceMount()).toBe(1)
  })
})

describe('setTabCanExpandPane', () => {
  it('publishes the first write for an unseen tab and a real toggle', () => {
    const store = createTestStore()
    const published = recordPublishedMapKeys(store)

    store.getState().setTabCanExpandPane(TAB_ID, false)
    expect(published).toEqual(['canExpandPaneByTabId'])
    expect(store.getState().canExpandPaneByTabId[TAB_ID]).toBe(false)

    store.getState().setTabCanExpandPane(TAB_ID, true)
    expect(published).toEqual(['canExpandPaneByTabId', 'canExpandPaneByTabId'])
    expect(store.getState().canExpandPaneByTabId[TAB_ID]).toBe(true)
  })

  it('bails out when the value is unchanged', () => {
    const store = createTestStore()
    store.getState().setTabCanExpandPane(TAB_ID, false)
    const before = store.getState().canExpandPaneByTabId
    const rootBefore = store.getState()
    const published = recordPublishedMapKeys(store)

    for (let i = 0; i < NO_OP_WRITES; i += 1) {
      store.getState().setTabCanExpandPane(TAB_ID, false)
    }

    expect(published).toEqual([])
    expect(store.getState().canExpandPaneByTabId).toBe(before)
    expect(store.getState()).toBe(rootBefore)
  })

  it('costs no React commit in a map subscriber when the value is unchanged', () => {
    const store = createTestStore()
    store.getState().setTabCanExpandPane(TAB_ID, false)
    const commitsSinceMount = renderCommitCounter(<CanExpandPaneSubscriber store={store} />)

    for (let i = 0; i < NO_OP_WRITES; i += 1) {
      act(() => {
        store.getState().setTabCanExpandPane(TAB_ID, false)
      })
    }
    expect(commitsSinceMount()).toBe(0)

    act(() => {
      store.getState().setTabCanExpandPane(TAB_ID, true)
    })
    expect(commitsSinceMount()).toBe(1)
  })
})
