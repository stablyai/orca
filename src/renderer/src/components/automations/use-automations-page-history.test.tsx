// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import type { WorktreeNavHistoryEntry } from '../../store/slices/ui/workspace-navigation-history'
import type { AutomationsPageLocation } from './automation-page-state'
import {
  useAutomationsPageFocus,
  useAutomationsPageHistory,
  type AutomationsPageFocusTarget
} from './use-automations-page-history'
import { AUTOMATIONS_REVEAL_RUN_EVENT } from './runs/automations-reveal-run'
import {
  automationsPageNotFoundLocation,
  automationsRunReturnSelector
} from './use-automations-page-routing'

const list: AutomationsPageLocation = { page: 'list' }
const detail: AutomationsPageLocation = { page: 'detail', automationId: 'a1' }
const run1: AutomationsPageLocation = {
  page: 'run',
  automationId: 'a1',
  runId: 'r1',
  origin: 'automation'
}
const run2: AutomationsPageLocation = { ...run1, runId: 'r2' }
type Props = { location: AutomationsPageLocation | null }
const onDetail: Props = { location: detail }
const onList: Props = { location: list }
const onRun2: Props = { location: run2 }

const entry = (location: AutomationsPageLocation): WorktreeNavHistoryEntry => ({
  kind: 'automations-page',
  location
})

beforeEach(() => {
  useAppStore.setState({
    activeView: 'automations',
    worktreeNavHistory: ['skills', entry(list), entry(detail)],
    worktreeNavHistoryIndex: 2,
    automationsPageLocationRequest: null,
    automationsPageNextVisitMode: 'push',
    automationsPageFocusTitleOnOpen: false,
    isNavigatingHistory: false
  })
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

it('does not record the page Back left while the replay is still applying', () => {
  const goToLocation = vi.fn()
  const { rerender } = renderHook(
    ({ location }: Props) => useAutomationsPageHistory({ location, navigation: { goToLocation } }),
    { initialProps: onDetail }
  )

  // Titlebar Back: the history index moves to the list entry and asks the page to show it.
  act(() => {
    useAppStore.setState({ worktreeNavHistoryIndex: 1, automationsPageLocationRequest: list })
  })
  expect(goToLocation).toHaveBeenCalledWith(list)
  expect(useAppStore.getState().automationsPageLocationRequest).toBeNull()

  // The cleared request can render before the page state it asked for (still detail).
  rerender({ location: detail })
  rerender({ location: list })

  const state = useAppStore.getState()
  expect(state.worktreeNavHistory).toEqual(['skills', entry(list), entry(detail)])
  expect(state.worktreeNavHistoryIndex).toBe(1)
})

it('records a sub-page the user opens', () => {
  useAppStore.setState({ worktreeNavHistory: ['skills', entry(list)], worktreeNavHistoryIndex: 1 })
  const goToLocation = vi.fn()
  const { rerender } = renderHook(
    ({ location }: Props) => useAutomationsPageHistory({ location, navigation: { goToLocation } }),
    { initialProps: onList }
  )
  rerender({ location: detail })
  const state = useAppStore.getState()
  expect(state.worktreeNavHistory).toEqual(['skills', entry(list), entry(detail)])
  expect(state.worktreeNavHistoryIndex).toBe(2)
})

it.each([
  ['from the global Runs page', { page: 'runs' } satisfies AutomationsPageLocation],
  ['with a detail entry that is not adjacent', detail]
])('a replay whose run cannot be shown keeps that entry and Forward (%s)', (_label, before) => {
  const history = ['skills', entry(before), entry(list), entry(run1), entry(run2)]
  useAppStore.setState({ worktreeNavHistory: history, worktreeNavHistoryIndex: 4 })
  const goToLocation = vi.fn()
  const { rerender } = renderHook(
    ({ location }: Props) => useAutomationsPageHistory({ location, navigation: { goToLocation } }),
    { initialProps: onRun2 }
  )
  act(() => {
    useAppStore.setState({ worktreeNavHistoryIndex: 3, automationsPageLocationRequest: run1 })
  })
  // The run's history read fails while resolving, so the page falls back to the detail.
  rerender({ location: null })
  rerender({ location: detail })

  const state = useAppStore.getState()
  // The entry still names the requested run, so Back/Forward can try it again.
  expect(state.worktreeNavHistory).toEqual(history)
  expect(state.worktreeNavHistoryIndex).toBe(3)
})

it('a replay that lands where it asked records nothing (control)', () => {
  const history = ['skills', entry(detail), entry(run1), entry(run2)]
  useAppStore.setState({ worktreeNavHistory: history, worktreeNavHistoryIndex: 3 })
  const goToLocation = vi.fn()
  const { rerender } = renderHook(
    ({ location }: Props) => useAutomationsPageHistory({ location, navigation: { goToLocation } }),
    { initialProps: onRun2 }
  )
  act(() => {
    useAppStore.setState({ worktreeNavHistoryIndex: 2, automationsPageLocationRequest: run1 })
  })
  rerender({ location: null })
  rerender({ location: run1 })
  expect(useAppStore.getState().worktreeNavHistory).toEqual(history)
  expect(useAppStore.getState().worktreeNavHistoryIndex).toBe(2)
})

function mountPage(): HTMLElement {
  const container = document.createElement('main')
  container.innerHTML =
    '<h1 tabindex="-1" data-automations-page-title>Title</h1><button data-automation-run-id="r9">Run</button>'
  document.body.appendChild(container)
  return container
}

const detailTarget: AutomationsPageFocusTarget = {
  key: 'detail:a1',
  page: 'detail',
  parents: ['list'],
  returnSelector: null
}

it('focuses the title when the user opens the page', () => {
  const container = mountPage()
  useAppStore.setState({ automationsPageFocusTitleOnOpen: true })
  renderHook(() => useAutomationsPageFocus(detailTarget, { current: container }))
  expect(document.activeElement?.hasAttribute('data-automations-page-title')).toBe(true)
  expect(useAppStore.getState().automationsPageFocusTitleOnOpen).toBe(false)
})

it('leaves focus alone when the page is restored without a user action', () => {
  const container = mountPage()
  renderHook(() => useAutomationsPageFocus(detailTarget, { current: container }))
  expect(document.activeElement).toBe(document.body)
})

it('asks the run table to reveal an off-screen run row on the way back', () => {
  const container = mountPage()
  container.querySelector('[data-automation-run-id]')?.remove()
  const reveal = vi.fn()
  window.addEventListener(AUTOMATIONS_REVEAL_RUN_EVENT, reveal)
  const runTarget: AutomationsPageFocusTarget = {
    key: 'run:r9',
    page: 'run',
    parents: ['detail', 'automationRuns', 'runs'],
    returnSelector: '[data-automation-run-id="r9"]',
    returnRunId: 'r9'
  }
  const runsTarget: AutomationsPageFocusTarget = {
    key: 'automationRuns:a1',
    page: 'automationRuns',
    parents: ['detail', 'list'],
    returnSelector: null
  }
  const { rerender } = renderHook(
    ({ target }: { target: AutomationsPageFocusTarget }) =>
      useAutomationsPageFocus(target, { current: container }),
    { initialProps: { target: runTarget } }
  )
  rerender({ target: runsTarget })
  window.removeEventListener(AUTOMATIONS_REVEAL_RUN_EVENT, reveal)
  expect(reveal).toHaveBeenCalled()
  expect(reveal.mock.calls[0]?.[0]).toMatchObject({ detail: { runId: 'r9' } })
})

it('records a deleted-run deep link as the run it asked for, so Back/Forward return there', () => {
  expect(
    automationsPageNotFoundLocation({
      kind: 'run',
      automationId: 'a1',
      runId: 'gone',
      origin: 'runs'
    })
  ).toEqual({ page: 'run', automationId: 'a1', runId: 'gone', origin: 'runs' })
  expect(
    automationsPageNotFoundLocation({ kind: 'automation', automationId: 'a1', runId: null })
  ).toEqual({ page: 'detail', automationId: 'a1', hostId: undefined })
})

describe('returning to a run whose table is still loading', () => {
  const runTarget: AutomationsPageFocusTarget = {
    key: 'run:r9',
    page: 'run',
    parents: ['detail', 'automationRuns', 'runs'],
    returnSelector: '[data-automation-run-id="r9"]',
    returnRunId: 'r9'
  }
  const runsTarget: AutomationsPageFocusTarget = {
    key: 'runs',
    page: 'runs',
    parents: [],
    returnSelector: null
  }

  function mountRunsPage(): HTMLElement {
    const container = document.createElement('main')
    container.innerHTML = '<input aria-label="Search runs" data-automations-page-search />'
    document.body.appendChild(container)
    return container
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function mountReturn(container: HTMLElement, target = runTarget) {
    const hook = renderHook(
      ({ t }: { t: AutomationsPageFocusTarget }) =>
        useAutomationsPageFocus(t, { current: container }),
      { initialProps: { t: target } }
    )
    hook.rerender({ t: runsTarget })
    return hook
  }

  function addRow(container: HTMLElement, attrs: Record<string, string> = {}): HTMLElement {
    const row = document.createElement('button')
    row.setAttribute('data-automation-run-id', 'r9')
    for (const [name, value] of Object.entries(attrs)) {
      row.setAttribute(name, value)
    }
    container.appendChild(row)
    return row
  }

  it('keeps the row when a refetch clears the cached row and lists it again 1.45s later', () => {
    const container = mountRunsPage()
    const cached = addRow(container)
    mountReturn(container)
    expect(document.activeElement).toBe(cached)
    act(() => {
      vi.advanceTimersByTime(100)
    })
    cached.remove()
    act(() => {
      vi.advanceTimersByTime(1350)
    })
    const fresh = addRow(container)
    act(() => {
      vi.advanceTimersByTime(50)
    })
    expect(document.activeElement).toBe(fresh)
  })

  it('stops repairing for good once the user focuses something else, even after a blur', () => {
    const container = mountRunsPage()
    const cached = addRow(container)
    mountReturn(container)
    expect(document.activeElement).toBe(cached)
    const search = container.querySelector<HTMLInputElement>('input')
    act(() => {
      search?.focus()
      vi.advanceTimersByTime(50)
      search?.blur()
    })
    cached.remove()
    addRow(container)
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(document.activeElement).toBe(document.body)
  })

  it('returns to the run on the right host when two hosts list the same run id', () => {
    const container = mountRunsPage()
    const hostA = addRow(container, { 'data-automation-run-key': 'row-a::r9' })
    const hostB = addRow(container, { 'data-automation-run-key': 'row-b::r9' })
    const reveal = vi.fn()
    window.addEventListener(AUTOMATIONS_REVEAL_RUN_EVENT, reveal)
    mountReturn(container, {
      ...runTarget,
      returnSelector: automationsRunReturnSelector('r9', 'row-b'),
      returnRunKey: 'row-b::r9'
    })
    window.removeEventListener(AUTOMATIONS_REVEAL_RUN_EVENT, reveal)
    expect(document.activeElement).toBe(hostB)
    expect(document.activeElement).not.toBe(hostA)
  })

  it('asks the table to reveal the host-qualified run while it is missing', () => {
    const container = mountRunsPage()
    const reveal = vi.fn()
    window.addEventListener(AUTOMATIONS_REVEAL_RUN_EVENT, reveal)
    mountReturn(container, {
      ...runTarget,
      returnSelector: automationsRunReturnSelector('r9', 'row-b'),
      returnRunKey: 'row-b::r9'
    })
    window.removeEventListener(AUTOMATIONS_REVEAL_RUN_EVENT, reveal)
    expect(reveal.mock.calls[0]?.[0]).toMatchObject({
      detail: { runId: 'r9', runKey: 'row-b::r9' }
    })
  })

  it('focuses the row once the reloaded data lists it (1.2s read)', () => {
    const container = mountRunsPage()
    const { rerender } = renderHook(
      ({ target }: { target: AutomationsPageFocusTarget }) =>
        useAutomationsPageFocus(target, { current: container }),
      { initialProps: { target: runTarget } }
    )
    rerender({ target: runsTarget })
    act(() => {
      vi.advanceTimersByTime(1200)
    })
    expect(document.activeElement).toBe(document.body)
    const row = document.createElement('button')
    row.setAttribute('data-automation-run-id', 'r9')
    container.appendChild(row)
    act(() => {
      vi.advanceTimersByTime(50)
    })
    expect(document.activeElement).toBe(row)
  })

  it('falls back to the page search after 5s when the row never appears', () => {
    const container = mountRunsPage()
    const { rerender } = renderHook(
      ({ target }: { target: AutomationsPageFocusTarget }) =>
        useAutomationsPageFocus(target, { current: container }),
      { initialProps: { target: runTarget } }
    )
    rerender({ target: runsTarget })
    act(() => {
      vi.advanceTimersByTime(4900)
    })
    expect(document.activeElement).toBe(document.body)
    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Search runs')
  })

  it('stops waiting when the user navigates away', () => {
    const container = mountRunsPage()
    const { rerender, unmount } = renderHook(
      ({ target }: { target: AutomationsPageFocusTarget }) =>
        useAutomationsPageFocus(target, { current: container }),
      { initialProps: { target: runTarget } }
    )
    rerender({ target: runsTarget })
    act(() => {
      vi.advanceTimersByTime(500)
    })
    unmount()
    const row = document.createElement('button')
    row.setAttribute('data-automation-run-id', 'r9')
    container.appendChild(row)
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(document.activeElement).toBe(document.body)
  })
})

it('focuses the list search when the user opens the list page', () => {
  const container = document.createElement('main')
  container.innerHTML = '<input aria-label="Search automations" data-automations-page-search />'
  document.body.appendChild(container)
  useAppStore.setState({ automationsPageFocusTitleOnOpen: true })
  renderHook(() =>
    useAutomationsPageFocus(
      { key: 'list', page: 'list', parents: [], returnSelector: null },
      { current: container }
    )
  )
  expect(document.activeElement?.getAttribute('aria-label')).toBe('Search automations')
})
