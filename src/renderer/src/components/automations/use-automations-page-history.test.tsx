// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import type { WorktreeNavHistoryEntry } from '../../store/slices/ui/workspace-navigation-history'
import type { AutomationsPageLocation } from './automation-page-state'
import {
  useAutomationsPageFocus,
  useAutomationsPageHistory,
  type AutomationsPageFocusTarget
} from './use-automations-page-history'
import { AUTOMATIONS_REVEAL_RUN_EVENT } from './runs/automations-reveal-run'
import { automationsPageNotFoundLocation } from './use-automations-page-routing'

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

it('a replay whose run cannot be shown swaps that entry instead of cutting Forward', () => {
  useAppStore.setState({
    worktreeNavHistory: ['skills', entry(detail), entry(run1), entry(run2)],
    worktreeNavHistoryIndex: 3
  })
  const goToLocation = vi.fn()
  const { rerender } = renderHook(
    ({ location }: Props) => useAutomationsPageHistory({ location, navigation: { goToLocation } }),
    { initialProps: onRun2 }
  )
  act(() => {
    useAppStore.setState({ worktreeNavHistoryIndex: 2, automationsPageLocationRequest: run1 })
  })
  // The run's history read fails while resolving, so the page falls back to the detail.
  rerender({ location: null })
  rerender({ location: detail })

  const state = useAppStore.getState()
  // The fallback is the page just before the run, so the index steps back to it; the run
  // stays as Forward and nothing is deleted.
  expect(state.worktreeNavHistory).toEqual(['skills', entry(detail), entry(run1), entry(run2)])
  expect(state.worktreeNavHistoryIndex).toBe(1)
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
