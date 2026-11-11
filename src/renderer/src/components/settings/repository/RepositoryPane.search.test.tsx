// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../../shared/constants'
import type { Repo } from '../../../../../shared/repo-types'
import { useAppStore } from '@/store'
import { TooltipProvider } from '../../ui/tooltip'
import { RepositoryPane } from './RepositoryPane'

beforeEach(() => useAppStore.setState(useAppStore.getInitialState(), true))
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('keeps a searched repository section editable when the query does not name the repository', async () => {
  vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {})
  const repo: Repo = {
    id: 'project-1',
    path: '/tmp/sample-project',
    displayName: 'Sample project',
    badgeColor: '',
    addedAt: 0
  }
  const saveSparsePreset = vi.fn().mockResolvedValue(null)
  useAppStore.setState({
    settings: getDefaultSettings('/tmp'),
    settingsSearchQuery: 'sparse',
    repos: [repo],
    sparsePresetsByRepo: {
      'project-1': [
        {
          id: 'web',
          repoId: 'project-1',
          name: 'Web',
          directories: ['apps/web'],
          createdAt: 0,
          updatedAt: 0
        }
      ]
    },
    sparsePresetsLoadStatusByRepo: { 'project-1': 'loaded' },
    saveSparsePreset
  })
  render(
    <TooltipProvider>
      <RepositoryPane
        repo={repo}
        yamlHooks={null}
        hasHooksFile={false}
        hooksInspectionReady
        mayNeedUpdate={false}
        updateRepo={vi.fn()}
        removeProject={vi.fn()}
      />
    </TooltipProvider>
  )

  fireEvent.click(screen.getByRole('button', { name: 'Edit Web' }))
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Web app' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save preset' }))
  await waitFor(() =>
    expect(saveSparsePreset).toHaveBeenCalledWith({
      repoId: 'project-1',
      id: 'web',
      name: 'Web app',
      directories: ['apps/web']
    })
  )
})

it.each([
  ['folder', 'new workspace', 'Setup script'],
  ['folder', 'workspace is removed', 'Archive script'],
  ['git', 'new worktree', 'Setup script'],
  ['git', 'worktree is archived', 'Archive script']
] as const)('finds editable %s hooks for %s', (kind, query, scriptLabel) => {
  const repo: Repo = {
    id: 'project-1',
    path: '/tmp/sample-project',
    displayName: 'Sample project',
    badgeColor: '',
    addedAt: 0,
    ...(kind === 'folder' ? { kind: 'folder' as const } : {})
  }
  const updateRepo = vi.fn()
  useAppStore.setState({
    settings: getDefaultSettings('/tmp'),
    settingsSearchQuery: query,
    repos: [repo]
  })
  render(
    <TooltipProvider>
      <RepositoryPane
        repo={repo}
        yamlHooks={null}
        hasHooksFile={false}
        hooksInspectionReady
        mayNeedUpdate={false}
        updateRepo={updateRepo}
        removeProject={vi.fn()}
      />
    </TooltipProvider>
  )

  const editor = screen.getByRole('textbox', { name: scriptLabel })
  fireEvent.change(editor, { target: { value: 'echo workspace-hook' } })
  fireEvent.blur(editor)
  expect(updateRepo).toHaveBeenCalledWith(
    'project-1',
    expect.objectContaining({
      hookSettings: expect.objectContaining({
        scripts: expect.objectContaining({
          [scriptLabel === 'Setup script' ? 'setup' : 'archive']: 'echo workspace-hook'
        })
      })
    }),
    expect.anything()
  )
})
