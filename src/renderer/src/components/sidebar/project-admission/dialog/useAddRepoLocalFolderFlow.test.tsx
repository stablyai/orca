// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import type {
  NestedRepoScanResult,
  ProjectGroupImportResult
} from '../../../../../../shared/project/groups/project-group-types'
import { useAddRepoNestedReviewController } from '../nested-import/useAddRepoNestedReviewController'
import { useAddRepoLocalFolderFlow } from './useAddRepoLocalFolderFlow'

vi.mock('@/diagnostics/telemetry/telemetry', () => ({ track: vi.fn() }))

const initialState = useAppStore.getState()
afterEach(() => {
  useAppStore.setState(initialState, true)
})

const path = '\\\\wsl.localhost\\Ubuntu\\home\\u\\notes'
const folder: Repo = { id: 'folder-1', path, displayName: 'notes', badgeColor: '#737', addedAt: 0 }
const app: Repo = { ...folder, id: 'app-1', path: `${path}\\app`, displayName: 'app' }
const api: Repo = { ...folder, id: 'api-1', path: `${path}\\api`, displayName: 'api' }
const scan: NestedRepoScanResult = {
  selectedPath: path,
  selectedPathKind: 'non_git_folder',
  repos: [
    { path: app.path, displayName: 'app', depth: 1 },
    { path: api.path, displayName: 'api', depth: 1 }
  ],
  truncated: false,
  timedOut: false,
  stopped: false,
  durationMs: 1,
  maxDepth: 4,
  maxRepos: 50,
  timeoutMs: null
}

const importedApp: ProjectGroupImportResult = {
  projects: [{ path: app.path, projectId: app.id, status: 'imported' }],
  importedCount: 1,
  alreadyKnownCount: 0,
  failedCount: 0
}

/** Composes nested review with the local flow, as AddRepoDialog does; closing resets review. */
async function addFolderWithNestedRepos(
  onGitRepoReady = vi.fn(async () => {}),
  imported = importedApp
) {
  const closeModal = vi.fn(() => result.current.review.resetNestedRepoReviewState())
  const { result } = renderHook(() => {
    const review = useAddRepoNestedReviewController({
      activeRuntimeEnvironmentId: null,
      reviewRuntimeEnvironmentId: null,
      cancelNestedRepoScan: vi.fn(async () => {}),
      closeModal,
      fetchWorktrees: vi.fn(async () => {}),
      importNestedRepos: vi.fn(async () => imported),
      onGitRepoReady,
      setIsAdding: vi.fn(),
      setStep: vi.fn()
    })
    const local = useAddRepoLocalFolderFlow({
      isOpen: false,
      droppedLocalPath: '',
      activeRuntimeEnvironmentId: null,
      addRepoPath: vi.fn(),
      openModal: vi.fn(),
      closeModal,
      fetchWorktrees: vi.fn(),
      scanNestedRepos: vi.fn(async () => scan),
      setActiveNestedScanId: review.setActiveNestedScanId,
      setNestedScanInProgress: review.setNestedScanInProgress,
      showNestedRepoReview: review.showNestedRepoReview,
      onGitRepoReady: vi.fn(),
      setIsAdding: vi.fn(),
      setAddProjectBusyLabel: vi.fn()
    })
    return { review, local }
  })
  let added: unknown
  await act(async () => {
    added = await result.current.local.handleAddLocalPath(path, 'local_folder_picker')
  })
  expect(added).toMatchObject({ status: 'paused' })
  const projectAdded =
    typeof added === 'object' && added !== null && 'projectAdded' in added
      ? added.projectAdded
      : undefined
  if (!(projectAdded instanceof Promise)) {
    throw new Error('nested review paused without waiting on the project it adds')
  }
  return { projectAdded, review: () => result.current.review }
}

describe('useAddRepoLocalFolderFlow nested review pause', () => {
  it('settles with the first imported repo once the add finished closing', async () => {
    useAppStore.setState({ repos: [app] })
    let settled = false
    let settledBeforeReady = false
    const { projectAdded, review } = await addFolderWithNestedRepos(
      vi.fn(async () => {
        review().resetNestedRepoReviewState()
        await new Promise((resolve) => setTimeout(resolve, 0))
        settledBeforeReady = settled
      })
    )
    void projectAdded.then(() => {
      settled = true
    })

    await act(() => review().handleImportNestedRepos('separate'))

    await expect(projectAdded).resolves.toEqual({
      repo: app,
      imported: [{ kind: 'repo', id: app.id }]
    })
    // The move opens after the add closed, as for a plain repo add.
    expect(settledBeforeReady).toBe(false)
  })

  it('lists every repo a group import added, so all of them start checked', async () => {
    useAppStore.setState({ repos: [app, api] })
    const { projectAdded, review } = await addFolderWithNestedRepos(undefined, {
      projects: [
        { path: app.path, projectId: app.id, status: 'imported' },
        { path: api.path, projectId: api.id, status: 'imported' }
      ],
      group: {
        id: 'group-1',
        name: 'notes',
        parentPath: path,
        parentGroupId: null,
        createdFrom: 'folder-scan',
        tabOrder: 0,
        isCollapsed: false,
        color: null,
        createdAt: 0,
        updatedAt: 0
      },
      importedCount: 2,
      alreadyKnownCount: 0,
      failedCount: 0
    })

    await act(() => review().handleImportNestedRepos('group'))

    await expect(projectAdded).resolves.toEqual({
      repo: app,
      imported: [
        { kind: 'repo', id: app.id },
        { kind: 'repo', id: api.id }
      ]
    })
  })

  it('settles with nothing when finishing the import throws', async () => {
    useAppStore.setState({ repos: [app] })
    const { projectAdded, review } = await addFolderWithNestedRepos(
      vi.fn(async () => {
        throw new Error('checkout failed')
      })
    )

    await act(() => review().handleImportNestedRepos('separate'))

    await expect(projectAdded).resolves.toBeNull()
  })

  it('settles with the folder "Open as Folder" adds, not the close that follows', async () => {
    useAppStore.setState({ addNonGitFolder: vi.fn(async () => folder) })
    const { projectAdded, review } = await addFolderWithNestedRepos()

    await act(() => review().handleOpenNestedRootFolder())

    await expect(projectAdded).resolves.toEqual({ repo: folder })
  })

  it('settles with nothing when the review closes without adding', async () => {
    const { projectAdded, review } = await addFolderWithNestedRepos()

    act(() => review().resetNestedRepoReviewState())

    await expect(projectAdded).resolves.toBeNull()
  })
})
