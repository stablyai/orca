// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import type { WorktreeNavHistoryEntry } from '../../store/slices/ui/workspace-navigation-history'
import type { AutomationsPageLocation } from './automation-page-state'
import { useAutomationsPageHistory } from './use-automations-page-history'

const list: AutomationsPageLocation = { page: 'list' }
const detail: AutomationsPageLocation = { page: 'detail', automationId: 'a1' }
type Props = { location: AutomationsPageLocation | null }
const onDetail: Props = { location: detail }
const onList: Props = { location: list }

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
    isNavigatingHistory: false
  })
})

afterEach(() => {
  cleanup()
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
