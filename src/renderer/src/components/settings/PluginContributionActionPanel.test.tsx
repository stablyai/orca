// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { PluginHostPanel } from '../../../../preload/api-types'
import type { AppState } from '@/store/types'
import { PluginContributionActionPanel } from './PluginContributionActionPanel'

const state = vi.hoisted(
  (): {
    previousViewBeforeSettings: AppState['previousViewBeforeSettings']
    activeWorktreeId: string | null
    closeSettingsPage: ReturnType<typeof vi.fn>
    setRightSidebarTab: ReturnType<typeof vi.fn>
    setRightSidebarOpen: ReturnType<typeof vi.fn>
  } => ({
    previousViewBeforeSettings: 'terminal',
    activeWorktreeId: 'wt-1',
    closeSettingsPage: vi.fn(),
    setRightSidebarTab: vi.fn(),
    setRightSidebarOpen: vi.fn()
  })
)
vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), {
    getState: () => state
  })
}))

const panel: PluginHostPanel = { id: 'tasks', title: 'Tasks', tabKey: 'plugin:acme.tasks/tasks' }

afterEach(() => {
  cleanup()
  state.previousViewBeforeSettings = 'terminal'
  state.activeWorktreeId = 'wt-1'
  state.closeSettingsPage.mockClear()
  state.setRightSidebarTab.mockClear()
  state.setRightSidebarOpen.mockClear()
})

it('leaves Settings for the workspace and reveals the panel there', () => {
  render(<PluginContributionActionPanel panel={panel} />)
  fireEvent.click(screen.getByRole('button', { name: 'Open panel: Tasks' }))
  expect(state.closeSettingsPage).toHaveBeenCalledOnce()
  expect(state.setRightSidebarTab).toHaveBeenCalledExactlyOnceWith('plugin:acme.tasks/tasks')
  expect(state.setRightSidebarOpen).toHaveBeenCalledExactlyOnceWith(true)
})

it('says why it is off when no workspace is open, and never closes Settings', () => {
  state.activeWorktreeId = null
  render(<PluginContributionActionPanel panel={panel} />)
  const button = screen.getByRole('button', { name: 'Open panel: Tasks' })
  expect(button).toBeDisabled()
  expect(screen.getByText('Open a workspace to see it.')).toBeInTheDocument()
  fireEvent.click(button)
  expect(state.closeSettingsPage).not.toHaveBeenCalled()
})

it('stays off when Settings would return to a view without a right sidebar', () => {
  state.previousViewBeforeSettings = 'tasks'
  render(<PluginContributionActionPanel panel={panel} />)
  expect(screen.getByRole('button', { name: 'Open panel: Tasks' })).toBeDisabled()
  expect(screen.getByText('Open a workspace to see it.')).toBeInTheDocument()
})
