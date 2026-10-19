// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { JiraProjectReference } from '../../../../shared/jira-project-reference'
import { RepositoryJiraProjectSection } from './RepositoryJiraProjectSection'
const project = { id: '10', key: 'ALP', name: 'Alpha', siteId: 'site-a' }
const { state, inventory } = vi.hoisted(() => {
  const repos: Repo[] = []
  return { state: { repos, settingsSearchQuery: '' }, inventory: vi.fn() }
})
vi.mock('@/store', () => {
  const useAppStore = (selector: (store: typeof state) => unknown) => selector(state)
  useAppStore.getState = () => state
  return { useAppStore }
})
vi.mock('../use-jira-project-inventory', () => ({ useJiraProjectInventory: inventory }))
vi.mock('../jira-project-picker', () => ({
  JiraProjectPicker: ({ onChange }: { onChange: (next: JiraProjectReference | null) => void }) => (
    <button onClick={() => onChange(project)}>Choose Alpha</button>
  )
}))
afterEach(cleanup)
beforeEach(() => {
  state.repos = [
    {
      id: 'repo',
      path: '/repo',
      displayName: 'Alpha',
      badgeColor: '',
      addedAt: 0,
      executionHostId: 'runtime:owner',
      kind: 'folder'
    }
  ]
  inventory.mockReturnValue({ connected: true, projects: [project], error: null, loading: false })
})
describe('repository Jira setting', () => {
  it('loads project choices from the owning runtime and accepts its persisted echo', async () => {
    const update = vi.fn(async () => {
      state.repos[0] = { ...state.repos[0], defaultJiraProject: project }
      return true
    })
    render(<RepositoryJiraProjectSection repo={state.repos[0]} updateRepo={update} />)
    expect(inventory).toHaveBeenCalledWith({ kind: 'environment', environmentId: 'owner' }, true)
    fireEvent.click(screen.getByRole('button', { name: 'Choose Alpha' }))
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith('repo', { defaultJiraProject: project })
    )
    expect(screen.queryByRole('alert')).toBeNull()
  })
  it('explains an old runtime ignoring the optional field instead of claiming it saved', async () => {
    const update = vi.fn(async () => true)
    render(<RepositoryJiraProjectSection repo={state.repos[0]} updateRepo={update} />)
    fireEvent.click(screen.getByRole('button', { name: 'Choose Alpha' }))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Update this runtime')
    )
    expect(state.repos[0].defaultJiraProject).toBeUndefined()
  })
})
