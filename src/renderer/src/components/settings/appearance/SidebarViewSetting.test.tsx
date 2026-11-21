// @vitest-environment happy-dom
import userEvent from '@testing-library/user-event'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
import SidebarHeader from '@/components/sidebar/chrome/SidebarHeader'
import { getDefaultUIState } from '../../../../../shared/orca-profiles/constants'
import type { PersistedUIState } from '../../../../../shared/orca-profiles/persisted-ui-state-types'
import { SidebarViewSetting } from './SidebarViewSetting'

const initial = useAppStore.getState()
const setUI = vi.fn((_updates: Partial<PersistedUIState>) => Promise.resolve())

function startWith(ui: Partial<PersistedUIState>): void {
  act(() => useAppStore.getState().hydratePersistedUI({ ...getDefaultUIState(), ...ui }, 'startup'))
  // Hydration's own one-shot migration writes are not the user's picks.
  setUI.mockClear()
}

function renderSettingsAndSidebar(): void {
  render(
    <TooltipProvider>
      <SidebarViewSetting />
      <SidebarHeader onWorkspaceBoardMenuOpenChange={() => undefined} />
    </TooltipProvider>
  )
}

function checkedView(): string | undefined {
  const group = screen.getByRole('radiogroup', { name: 'Sidebar view' })
  return group.querySelector('[aria-checked="true"]')?.textContent ?? undefined
}

function shownView(): string | null {
  return (
    document
      .querySelector('[data-sidebar-section-title]')
      ?.getAttribute('data-sidebar-section-title') ?? null
  )
}

beforeEach(() => {
  vi.stubGlobal('api', { ...window.api, ui: { ...window.api?.ui, set: setUI } })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  useAppStore.setState(initial, true)
})

it('shows and remembers Sessions when it is picked in Appearance', async () => {
  startWith({})
  renderSettingsAndSidebar()

  await userEvent.click(screen.getByRole('radio', { name: 'Sessions' }))

  expect(shownView()).toBe('sessions')
  expect(setUI).toHaveBeenCalledWith({ sidebarView: 'conversations' })
})

it('moves the Appearance choice when the sidebar title menu picks a view', async () => {
  startWith({ sidebarView: 'conversations' })
  renderSettingsAndSidebar()
  expect(checkedView()).toBe('Sessions')

  await userEvent.click(screen.getByRole('button', { name: 'Sessions' }))
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Projects' }))

  expect(checkedView()).toBe('Projects')
  expect(shownView()).toBe('projects')
  expect(setUI).toHaveBeenLastCalledWith({ sidebarView: 'workspaces' })
})

it('keeps the chosen view while Activity is on and returns to it afterwards', async () => {
  startWith({ sidebarView: 'conversations' })
  renderSettingsAndSidebar()

  await userEvent.click(screen.getByRole('button', { name: 'View activity' }))
  expect(shownView()).toBe('activity')
  expect(checkedView()).toBe('Sessions')

  await userEvent.click(screen.getByRole('button', { name: 'Turn off activity view' }))
  expect(shownView()).toBe('sessions')
  expect(setUI).not.toHaveBeenCalled()
})
