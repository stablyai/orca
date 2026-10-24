// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const storeState = {
  settings: { askProjectKindOnAdd: true },
  addNonGitFolder: vi.fn()
}

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof storeState) => unknown) => selector(storeState)
}))

import { useProjectKindChoice } from './use-project-kind-choice'

const folderRepo = {
  id: 'web',
  path: '/mono/apps/web',
  displayName: 'web',
  badgeColor: '#999999',
  addedAt: 1,
  kind: 'folder' as const
}

beforeEach(() => {
  storeState.settings.askProjectKindOnAdd = true
  storeState.addNonGitFolder.mockReset().mockResolvedValue(folderRepo)
})

afterEach(() => {
  cleanup()
})

describe('useProjectKindChoice', () => {
  it('is inactive when the setting is off', () => {
    storeState.settings.askProjectKindOnAdd = false
    const { result } = renderHook(() => useProjectKindChoice(vi.fn()))
    expect(result.current.chooseProjectKind).toBeUndefined()
  })

  it('adds the picked path as a folder project and closes the add dialog', async () => {
    const closeModal = vi.fn()
    const { result } = renderHook(() => useProjectKindChoice(closeModal))

    let pending!: ReturnType<NonNullable<typeof result.current.chooseProjectKind>>
    act(() => {
      pending = result.current.chooseProjectKind!('/mono/apps/web')
    })
    expect(result.current.pendingPath).toBe('/mono/apps/web')

    act(() => result.current.resolveProjectKind('folder'))

    await expect(pending).resolves.toEqual({ status: 'completed', repo: folderRepo })
    expect(storeState.addNonGitFolder).toHaveBeenCalledWith('/mono/apps/web', {
      runtimeEnvironmentId: null
    })
    expect(closeModal).toHaveBeenCalledTimes(1)
    expect(result.current.pendingPath).toBeNull()
  })

  it('hands git back to the caller and treats dismissal as paused', async () => {
    const closeModal = vi.fn()
    const { result } = renderHook(() => useProjectKindChoice(closeModal))

    let gitChoice!: ReturnType<NonNullable<typeof result.current.chooseProjectKind>>
    act(() => {
      gitChoice = result.current.chooseProjectKind!('/mono')
    })
    act(() => result.current.resolveProjectKind('git'))
    await expect(gitChoice).resolves.toBe('git')

    let dismissed!: ReturnType<NonNullable<typeof result.current.chooseProjectKind>>
    act(() => {
      dismissed = result.current.chooseProjectKind!('/mono')
    })
    act(() => result.current.resolveProjectKind(null))
    await expect(dismissed).resolves.toEqual({ status: 'paused' })

    expect(storeState.addNonGitFolder).not.toHaveBeenCalled()
    expect(closeModal).not.toHaveBeenCalled()
  })
})
