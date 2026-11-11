// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ProjectHostSetup } from '../../../../../shared/project-types'
import type { Repo } from '../../../../../shared/repo-types'
import { useAppStore } from '@/store'
import {
  makeTerminalTab,
  makeWorktree
} from '../../worktree-jump/worktree-jump-palette-test-fixtures'
import { RepositoryRemoveProjectSection } from './RepositoryRemoveProjectSection'

beforeEach(() => useAppStore.setState(useAppStore.getInitialState(), true))
afterEach(cleanup)

const repo: Repo = {
  id: 'repo-1',
  path: '/tmp/project',
  displayName: 'project',
  badgeColor: '',
  addedAt: 0
}
const setup: ProjectHostSetup = {
  id: 'setup-1',
  projectId: 'project-1',
  hostId: 'local',
  repoId: 'repo-1',
  path: '/tmp/project',
  displayName: 'project',
  setupState: 'ready',
  setupMethod: 'imported-existing-folder',
  createdAt: 0,
  updatedAt: 0
}

it('holds removal when a terminal opens while the confirm dialog is up', () => {
  const removeProject = vi.fn()
  useAppStore.setState({
    worktreesByRepo: { 'repo-1': [makeWorktree('wt-1', 'main')] }
  })
  render(
    <RepositoryRemoveProjectSection
      repo={repo}
      setups={[setup]}
      removalScope="project"
      searchEntry={{ title: 'Remove project' }}
      forceVisible
      removeProject={removeProject}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Remove…' }))
  useAppStore.setState({
    tabsByWorktree: { 'wt-1': [makeTerminalTab('tab-1', 'wt-1', 'Terminal')] },
    ptyIdsByTabId: { 'tab-1': ['pty-1'] }
  })

  fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
  expect(removeProject).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
  expect(removeProject).toHaveBeenCalledTimes(1)
})
