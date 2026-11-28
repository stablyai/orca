// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'
import { useAppStore } from '@/store/index'
import { activateListRailItem, isListRailItemActive } from './app-rail-navigation'

const initial = useAppStore.getState()

afterEach(() => {
  useAppStore.setState(initial, true)
})

it('opens Activity from a rail page, with the list showing it', () => {
  useAppStore.getState().openAutomationsPage()
  useAppStore.getState().setSidebarOpen(false)
  activateListRailItem(useAppStore, 'activity')
  const state = useAppStore.getState()
  expect(state.activeView).toBe('terminal')
  expect(state.sidebarBody).toBe('agents')
  expect(state.sidebarOpen).toBe(true)
  expect(isListRailItemActive(state, 'activity')).toBe(true)
  expect(isListRailItemActive(state, 'workspaces')).toBe(false)
})

it('collapses the list when Activity is clicked while current, as Workspaces does', () => {
  activateListRailItem(useAppStore, 'activity')
  expect(useAppStore.getState().sidebarOpen).toBe(true)
  activateListRailItem(useAppStore, 'activity')
  expect(useAppStore.getState().sidebarOpen).toBe(false)
  // Still Activity's list, so the next click reopens it there.
  expect(useAppStore.getState().sidebarBody).toBe('agents')
})

it('switches from Activity back to Workspaces without collapsing', () => {
  activateListRailItem(useAppStore, 'activity')
  activateListRailItem(useAppStore, 'workspaces')
  const state = useAppStore.getState()
  expect(state.sidebarBody).toBe('workspaces')
  expect(state.sidebarOpen).toBe(true)
})
