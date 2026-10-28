// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { WorkspaceViewPicker } from './WorkspaceViewPicker'

const fixture = vi.hoisted(() => {
  const entries = [
    {
      workspaceId: 'payments',
      executionHostId: 'local',
      tabId: 'api',
      title: 'API shell',
      projectName: 'Payments API',
      workspaceName: 'main'
    },
    {
      workspaceId: 'storefront',
      executionHostId: 'local',
      tabId: 'app',
      title: 'App shell',
      projectName: 'Storefront',
      workspaceName: 'main'
    },
    {
      workspaceId: 'docs',
      executionHostId: 'local',
      tabId: 'notes',
      title: 'Architecture.md',
      projectName: 'Documentation',
      workspaceName: 'main'
    },
    {
      workspaceId: 'review',
      executionHostId: 'local',
      tabId: 'review-shell',
      title: 'Review shell',
      projectName: 'Storefront',
      workspaceName: 'review'
    }
  ]
  const state = {
    workspaceViewPicker: { workspaceId: 'storefront' },
    unifiedTabsByWorktree: {},
    setWorkspaceViewPicker: vi.fn(),
    addWorkspaceViewPanel: vi.fn<(panel: unknown, replaceId?: string) => string>(
      () => 'selected-panel'
    )
  }
  return { entries, state, focus: vi.fn() }
})

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof fixture.state) => unknown) => selector(fixture.state),
    { getState: () => fixture.state }
  )
}))
vi.mock('@/lib/workspace-view-catalog', () => ({
  collectWorkspaceViewPanels: () => fixture.entries,
  selectShownWorkspaceView: () => ({ panels: [] })
}))
vi.mock('./use-workspace-view-catalog-state', () => ({ useWorkspaceViewCatalogState: () => ({}) }))
vi.mock('@/lib/workspace-view-actions', () => ({ focusWorkspaceViewPanel: fixture.focus }))
vi.mock('@/lib/execution-host-display-label', () => ({
  selectExecutionHostDisplayLabel: () => 'Local'
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({}) }))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it('offers other projects and worktrees when opened from a workspace context menu', () => {
  render(<WorkspaceViewPicker />)
  expect(screen.getAllByRole('option')).toHaveLength(4)
  expect(screen.getAllByRole('option')[0].textContent).toContain('App shell')
  expect(screen.getByText('Payments API / main')).toBeTruthy()
  expect(screen.getByText('Documentation / main')).toBeTruthy()
  expect(screen.getByText('Storefront / review')).toBeTruthy()

  fireEvent.click(screen.getByRole('option', { name: 'API shell' }))
  fireEvent.click(screen.getByRole('option', { name: 'Architecture.md' }))
  fireEvent.click(screen.getByRole('button', { name: 'Add selected panels' }))
  expect(fixture.state.addWorkspaceViewPanel.mock.calls.map((call) => call[0])).toEqual([
    fixture.entries[0],
    fixture.entries[2]
  ])
  expect(fixture.focus).toHaveBeenCalledWith('selected-panel', true)
})
