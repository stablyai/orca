// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store'
import type { Repo, Space } from '../../../../shared/types'
import { DEFAULT_SPACE_ID } from '../../../../shared/spaces'

const mocks = vi.hoisted(() => ({
  finishGitRepoAdd: vi.fn(),
  moveProjectToSpace: vi.fn(),
  setActiveSpace: vi.fn(),
  onConflict: vi.fn(),
  state: {} as Partial<AppState>,
  toastInfo: vi.fn(),
  toastSuccess: vi.fn()
}))

vi.mock('@/store', () => {
  const useAppStore = Object.assign(
    (selector: (state: Partial<AppState>) => unknown) => selector(mocks.state),
    { getState: () => mocks.state }
  )
  return { useAppStore }
})

vi.mock('sonner', () => ({
  toast: { info: mocks.toastInfo, success: mocks.toastSuccess }
}))

import { useAddRepoSpaceConflict } from './use-add-repo-space-conflict'

const spaces: Space[] = [
  { id: DEFAULT_SPACE_ID, name: 'Personal', emoji: null, createdAt: 0, updatedAt: 0 },
  { id: 'space:work', name: 'Work', emoji: null, createdAt: 1, updatedAt: 1 }
]

const repo: Repo = {
  id: 'repo-1',
  displayName: 'Orca',
  path: '/projects/orca',
  badgeColor: '#000',
  addedAt: 1,
  spaceId: 'space:work'
}

describe('useAddRepoSpaceConflict', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.finishGitRepoAdd.mockResolvedValue(undefined)
    mocks.moveProjectToSpace.mockResolvedValue(true)
    mocks.state = {
      repos: [repo],
      spaces,
      activeSpaceId: DEFAULT_SPACE_ID,
      moveProjectToSpace: mocks.moveProjectToSpace,
      setActiveSpace: mocks.setActiveSpace
    } as Partial<AppState>
  })

  it('pauses completion when an existing project belongs to another Space', async () => {
    const { result } = renderHook(() =>
      useAddRepoSpaceConflict({
        finishGitRepoAdd: mocks.finishGitRepoAdd,
        onConflict: mocks.onConflict
      })
    )

    await act(() =>
      result.current.completeGitRepoAdd('repo-1', 'local_folder_picker', 'local', true)
    )

    expect(result.current.conflictView?.sourceSpaceName).toBe('Work')
    expect(mocks.onConflict).toHaveBeenCalledTimes(1)
    expect(mocks.finishGitRepoAdd).not.toHaveBeenCalled()
  })

  it('opens an existing project immediately when it is already in the active Space', async () => {
    mocks.state = { ...mocks.state, repos: [{ ...repo, spaceId: null }] }
    const { result } = renderHook(() =>
      useAddRepoSpaceConflict({
        finishGitRepoAdd: mocks.finishGitRepoAdd,
        onConflict: mocks.onConflict
      })
    )

    await act(() =>
      result.current.completeGitRepoAdd('repo-1', 'local_folder_picker', 'local', true)
    )

    expect(mocks.toastInfo).toHaveBeenCalledWith('Project already in Personal', {
      description: 'Orca'
    })
    expect(mocks.finishGitRepoAdd).toHaveBeenCalled()
    expect(mocks.onConflict).not.toHaveBeenCalled()
  })

  it('moves the host-qualified project before completing the add flow', async () => {
    const { result } = renderHook(() =>
      useAddRepoSpaceConflict({
        finishGitRepoAdd: mocks.finishGitRepoAdd,
        onConflict: mocks.onConflict
      })
    )
    await act(() =>
      result.current.completeGitRepoAdd('repo-1', 'local_folder_picker', 'local', true)
    )

    await act(() => result.current.moveToActiveSpace())

    expect(mocks.moveProjectToSpace).toHaveBeenCalledWith('repo-1', DEFAULT_SPACE_ID, 'local')
    expect(mocks.finishGitRepoAdd).toHaveBeenCalledWith('repo-1', 'local_folder_picker', 'local')
  })

  it('switches to the source Space before opening the project', async () => {
    const { result } = renderHook(() =>
      useAddRepoSpaceConflict({
        finishGitRepoAdd: mocks.finishGitRepoAdd,
        onConflict: mocks.onConflict
      })
    )
    await act(() =>
      result.current.completeGitRepoAdd('repo-1', 'local_folder_picker', 'local', true)
    )

    await act(() => result.current.openSourceSpace())

    expect(mocks.setActiveSpace).toHaveBeenCalledWith('space:work')
    expect(mocks.finishGitRepoAdd).toHaveBeenCalled()
  })

  it('keeps a failed move actionable in the conflict step', async () => {
    mocks.moveProjectToSpace.mockResolvedValue(false)
    const { result } = renderHook(() =>
      useAddRepoSpaceConflict({
        finishGitRepoAdd: mocks.finishGitRepoAdd,
        onConflict: mocks.onConflict
      })
    )
    await act(() =>
      result.current.completeGitRepoAdd('repo-1', 'local_folder_picker', 'local', true)
    )

    await act(() => result.current.moveToActiveSpace())

    expect(result.current.error).toContain('Couldn’t move this project to Personal')
    expect(mocks.finishGitRepoAdd).not.toHaveBeenCalled()
  })
})
