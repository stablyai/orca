// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'

import type { GitStatusEntry } from '../../../../../../shared/git-status-types'

const { toastErrorMock } = vi.hoisted(() => ({ toastErrorMock: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: toastErrorMock } }))

import { useSourceControlSubmoduleChanges } from './use-submodule-changes'

const ENTRY: GitStatusEntry = { path: 'a.txt', status: 'modified', area: 'unstaged' }
const gitApi = {
  status: vi.fn(),
  bulkStage: vi.fn(),
  bulkUnstage: vi.fn(),
  commit: vi.fn()
}

function renderChanges(worktreePath: string | null = '/repo', onCommitted = vi.fn()) {
  return {
    onCommitted,
    ...renderHook(
      ({ path }) => useSourceControlSubmoduleChanges({ worktreePath: path, onCommitted }),
      { initialProps: { path: worktreePath } }
    )
  }
}

beforeEach(() => {
  gitApi.status.mockReset().mockResolvedValue({ entries: [ENTRY] })
  gitApi.bulkStage.mockReset().mockResolvedValue(undefined)
  gitApi.bulkUnstage.mockReset().mockResolvedValue(undefined)
  gitApi.commit.mockReset().mockResolvedValue({ success: true })
  toastErrorMock.mockReset()
  Object.defineProperty(window, 'api', { configurable: true, value: { git: gitApi } })
})

afterEach(cleanup)

describe('useSourceControlSubmoduleChanges', () => {
  it('reads the submodule status when its row opens, and not before', async () => {
    const { result } = renderChanges()
    expect(gitApi.status).not.toHaveBeenCalled()

    act(() => result.current.toggle('libs/sub'))

    await waitFor(() =>
      expect(result.current.changesByPath['libs/sub']).toEqual({
        status: 'ready',
        entries: [ENTRY]
      })
    )
    expect(gitApi.status).toHaveBeenCalledWith(
      expect.objectContaining({ worktreePath: '/repo', submodulePath: 'libs/sub' })
    )
    expect(result.current.expanded.has('libs/sub')).toBe(true)
  })

  it('closes an open row without another read', async () => {
    const { result } = renderChanges()
    act(() => result.current.toggle('libs/sub'))
    await waitFor(() => expect(result.current.changesByPath['libs/sub']).toBeDefined())

    act(() => result.current.toggle('libs/sub'))

    expect(result.current.expanded.has('libs/sub')).toBe(false)
    expect(gitApi.status).toHaveBeenCalledTimes(1)
  })

  it('shows the git error when the status cannot be read', async () => {
    gitApi.status.mockRejectedValue(new Error('not a git repository'))
    const { result } = renderChanges()

    act(() => result.current.toggle('libs/sub'))

    await waitFor(() =>
      expect(result.current.changesByPath['libs/sub']).toEqual({
        status: 'error',
        message: expect.stringContaining('not a git repository')
      })
    )
  })

  it('stages and unstages in the named submodule, then reads it again', async () => {
    const { result } = renderChanges()
    act(() => result.current.toggle('libs/sub'))
    await waitFor(() => expect(result.current.changesByPath['libs/sub']).toBeDefined())

    await act(async () => {
      await result.current.stage('libs/sub', ['a.txt', 'b.txt'])
    })
    await act(async () => {
      await result.current.unstage('libs/sub', ['a.txt'])
    })

    expect(gitApi.bulkStage).toHaveBeenCalledWith({
      worktreePath: '/repo',
      submodulePath: 'libs/sub',
      filePaths: ['a.txt', 'b.txt']
    })
    expect(gitApi.bulkUnstage).toHaveBeenCalledWith({
      worktreePath: '/repo',
      submodulePath: 'libs/sub',
      filePaths: ['a.txt']
    })
    expect(gitApi.status).toHaveBeenCalledTimes(3)
    expect(result.current.busyPath).toBeNull()
  })

  it('sends nothing for an empty file list', async () => {
    const { result } = renderChanges()
    await act(async () => {
      await result.current.stage('libs/sub', [])
    })
    expect(gitApi.bulkStage).not.toHaveBeenCalled()
  })

  it('reports a failed stage and still reads the submodule again', async () => {
    gitApi.bulkStage.mockRejectedValue(new Error('index.lock exists'))
    const { result } = renderChanges()
    act(() => result.current.toggle('libs/sub'))
    await waitFor(() => expect(result.current.changesByPath['libs/sub']).toBeDefined())

    await act(async () => {
      await result.current.stage('libs/sub', ['a.txt'])
    })

    expect(toastErrorMock).toHaveBeenCalledWith(expect.stringContaining('index.lock'))
    expect(gitApi.status).toHaveBeenCalledTimes(2)
  })

  it('commits the trimmed message, clears it, reads again and tells the parent', async () => {
    const { result, onCommitted } = renderChanges()
    act(() => result.current.toggle('libs/sub'))
    await waitFor(() => expect(result.current.changesByPath['libs/sub']).toBeDefined())
    act(() => result.current.setMessage('libs/sub', '  fix it  '))

    await act(async () => {
      await result.current.commit('libs/sub')
    })

    expect(gitApi.commit).toHaveBeenCalledWith({
      worktreePath: '/repo',
      submodulePath: 'libs/sub',
      message: 'fix it'
    })
    expect(result.current.messageByPath['libs/sub']).toBe('')
    expect(onCommitted).toHaveBeenCalledTimes(1)
    expect(gitApi.status).toHaveBeenCalledTimes(2)
  })

  it('keeps the message and tells nobody when the commit fails', async () => {
    gitApi.commit.mockResolvedValue({ success: false, error: 'nothing to commit' })
    const { result, onCommitted } = renderChanges()
    act(() => result.current.setMessage('libs/sub', 'fix it'))

    await act(async () => {
      await result.current.commit('libs/sub')
    })

    expect(toastErrorMock).toHaveBeenCalledWith('nothing to commit')
    expect(result.current.messageByPath['libs/sub']).toBe('fix it')
    expect(onCommitted).not.toHaveBeenCalled()
  })

  it('does not commit an empty message', async () => {
    const { result } = renderChanges()
    act(() => result.current.setMessage('libs/sub', '   '))
    await act(async () => {
      await result.current.commit('libs/sub')
    })
    expect(gitApi.commit).not.toHaveBeenCalled()
  })

  it('forgets open rows and messages when the worktree changes', async () => {
    const { result, rerender } = renderChanges('/old')
    act(() => result.current.toggle('libs/sub'))
    act(() => result.current.setMessage('libs/sub', 'draft'))

    rerender({ path: '/new' })

    expect(result.current.expanded.size).toBe(0)
    expect(result.current.messageByPath).toEqual({})
  })

  it('keeps the new worktree state when the old worktree answers late', async () => {
    let resolveOld: (value: { entries: GitStatusEntry[] }) => void = () => {}
    gitApi.status
      .mockReset()
      .mockImplementationOnce(() => new Promise((resolve) => (resolveOld = resolve)))
      .mockResolvedValue({ entries: [ENTRY] })
    const { result, rerender } = renderChanges('/old')
    act(() => result.current.toggle('libs/sub'))
    rerender({ path: '/new' })
    act(() => result.current.toggle('libs/sub'))
    await waitFor(() => expect(result.current.changesByPath['libs/sub']?.status).toBe('ready'))

    await act(async () => {
      resolveOld({ entries: [] })
    })

    expect(result.current.changesByPath['libs/sub']).toEqual({ status: 'ready', entries: [ENTRY] })
  })

  it('does nothing while the worktree is hidden', async () => {
    const { result } = renderChanges(null)
    act(() => result.current.toggle('libs/sub'))
    await act(async () => {
      await result.current.stage('libs/sub', ['a.txt'])
    })
    expect(gitApi.status).not.toHaveBeenCalled()
    expect(gitApi.bulkStage).not.toHaveBeenCalled()
  })
})
