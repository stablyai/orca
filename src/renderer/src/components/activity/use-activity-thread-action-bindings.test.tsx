// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentPaneThread } from './activity-thread-types'
import type * as ActivityClearCompleted from './activity-clear-completed'
import { makeTab, makeWorktree } from './ActivityPrototypePage-test-fixtures'

const mocks = vi.hoisted(() => ({
  clearCompletedActivity: vi.fn()
}))

vi.mock('./activity-clear-completed', async (importOriginal) => ({
  ...(await importOriginal<typeof ActivityClearCompleted>()),
  clearCompletedActivity: mocks.clearCompletedActivity
}))

vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))

import { useActivityThreadActionBindings } from './use-activity-thread-action-bindings'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function makeThread(paneKey: string, overrides: Partial<AgentPaneThread> = {}): AgentPaneThread {
  return {
    paneKey,
    tab: makeTab(),
    worktree: makeWorktree(),
    repo: null,
    currentAgentState: 'working',
    currentAgentEntry: null,
    latestEvent: null,
    latestTimestamp: 1_000,
    agentType: 'claude',
    unread: false,
    paneTitle: 'Agent',
    responsePreview: '',
    events: [],
    paneEntry: {
      paneKey,
      state: 'done',
      prompt: '',
      updatedAt: 1_000,
      stateStartedAt: 1_000,
      stateHistory: []
    },
    ...overrides
  }
}

type HookResult = ReturnType<typeof useActivityThreadActionBindings>

let container: HTMLDivElement
let root: Root
let latest: HookResult | null

function Probe(props: Parameters<typeof useActivityThreadActionBindings>[0]): null {
  latest = useActivityThreadActionBindings(props)
  return null
}

function renderProbe(props: Parameters<typeof useActivityThreadActionBindings>[0]): HookResult {
  act(() => {
    root.render(<Probe {...props} />)
  })
  if (!latest) {
    throw new Error('hook did not render')
  }
  return latest
}

beforeEach(() => {
  mocks.clearCompletedActivity.mockClear()
  latest = null
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('useActivityThreadActionBindings', () => {
  const acknowledgeAgents = vi.fn()
  const baseProps = {
    acknowledgeAgents,
    unacknowledgeAgents: vi.fn(),
    setSelectedPaneKey: vi.fn()
  }

  beforeEach(() => {
    acknowledgeAgents.mockClear()
  })

  it('enables and applies Mark all read from the badge set, not the narrowed visible set', () => {
    const hiddenUnread = makeThread('tab-1:hidden', { unread: true })
    const bindings = renderProbe({
      ...baseProps,
      // Search/scope narrowing hid the only unread thread from the list…
      visibleThreads: [makeThread('tab-2:read')],
      // …but it is still in the badge-coherent set, so it must stay clearable.
      markAllReadThreads: [makeThread('tab-2:read'), hiddenUnread]
    })

    expect(bindings.hasUnreadThreads).toBe(true)
    bindings.markAllThreadsRead()
    expect(acknowledgeAgents).toHaveBeenCalledWith([hiddenUnread.paneKey], undefined, 'explicit')
  })

  it('clears completed strictly from the visible set', () => {
    const visibleDone = makeThread('tab-1:done', { currentAgentState: null })
    const hiddenDone = makeThread('tab-2:hidden-done', { currentAgentState: null })
    const bindings = renderProbe({
      ...baseProps,
      visibleThreads: [visibleDone],
      markAllReadThreads: [visibleDone, hiddenDone]
    })

    expect(bindings.hasCompletedThreads).toBe(true)
    bindings.handleClearCompleted()
    expect(mocks.clearCompletedActivity).toHaveBeenCalledWith([visibleDone])
  })

  it('disables clear-completed when completions are only outside the visible set', () => {
    const hiddenDone = makeThread('tab-2:hidden-done', { currentAgentState: null })
    const bindings = renderProbe({
      ...baseProps,
      visibleThreads: [makeThread('tab-1:working')],
      markAllReadThreads: [makeThread('tab-1:working'), hiddenDone]
    })

    expect(bindings.hasCompletedThreads).toBe(false)
  })
})
