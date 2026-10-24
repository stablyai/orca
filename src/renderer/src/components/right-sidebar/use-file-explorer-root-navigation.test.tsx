// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useFileExplorerRootNavigation } from './use-file-explorer-root-navigation'

const actions = vi.hoisted(() => ({
  clearPendingExplorerReveal: vi.fn(),
  setExplorerDisplayRootForWorktree: vi.fn()
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => actions } }))
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', { api: { repos: { pickDirectory: vi.fn() } } })
})
const options = [
  { value: '/', label: 'Repository root' },
  { value: 'app', label: 'app' }
]

it('offers a return after an outside reveal and clears it on explicit navigation', () => {
  const { result, rerender } = renderHook(
    ({ choice }) => useFileExplorerRootNavigation('wt', choice, options, '/repo'),
    { initialProps: { choice: 'app' } }
  )
  act(() => result.current.revealOutsideRoot())
  expect(actions.setExplorerDisplayRootForWorktree).toHaveBeenCalledWith('wt', '/')
  expect(actions.clearPendingExplorerReveal).not.toHaveBeenCalled()
  rerender({ choice: '/' })
  expect(result.current.returnRoot?.value).toBe('app')
  act(() => result.current.selectRoot('app'))
  expect(actions.clearPendingExplorerReveal).toHaveBeenCalledOnce()
  expect(actions.setExplorerDisplayRootForWorktree).toHaveBeenLastCalledWith('wt', 'app')
  expect(result.current.returnRoot).toBeNull()
})

it('never returns into another workspace or a removed sparse directory', () => {
  const { result, rerender } = renderHook(
    ({ id, choice, roots }) => useFileExplorerRootNavigation(id, choice, roots, '/repo'),
    { initialProps: { id: 'first', choice: 'app', roots: options } }
  )
  act(() => result.current.revealOutsideRoot())
  rerender({ id: 'second', choice: '/', roots: options })
  expect(result.current.returnRoot).toBeNull()
  rerender({ id: 'first', choice: '/', roots: [options[0]] })
  expect(result.current.returnRoot).toBeNull()
})

it('does not manufacture a return target when already at the repository root', () => {
  const { result } = renderHook(() => useFileExplorerRootNavigation('wt', '/', options, '/repo'))
  act(() => result.current.revealOutsideRoot())
  expect(result.current.returnRoot).toBeNull()
  expect(actions.setExplorerDisplayRootForWorktree).not.toHaveBeenCalled()
})

it('navigates to ancestors and returns to the workspace root', () => {
  const { result } = renderHook(() => useFileExplorerRootNavigation('wt', '/', options, '/repo'))

  act(() => result.current.navigateToPath('/tmp/reference'))
  expect(result.current.browsedRootPath).toBe('/tmp/reference')
  act(() => result.current.goUp())
  expect(result.current.browsedRootPath).toBe('/tmp')
  act(() => result.current.backToWorkspace())
  expect(result.current.browsedRootPath).toBeNull()
})

it('restores the existing sparse workspace choice when leaving a browsed folder', () => {
  const { result } = renderHook(() => useFileExplorerRootNavigation('wt', 'app', options, '/repo'))

  act(() => result.current.navigateToPath('/tmp/reference'))
  act(() => result.current.backToWorkspace())

  expect(result.current.browsedRootPath).toBeNull()
  expect(actions.setExplorerDisplayRootForWorktree).not.toHaveBeenCalled()
})

it('keeps browsed roots per workspace in memory but resets on remount', () => {
  const { result, rerender, unmount } = renderHook(
    ({ id, path }) => useFileExplorerRootNavigation(id, '/', options, path),
    { initialProps: { id: 'first', path: '/repo-a' } }
  )
  act(() => result.current.navigateToPath('/tmp/reference'))
  rerender({ id: 'second', path: '/repo-b' })
  expect(result.current.browsedRootPath).toBeNull()
  rerender({ id: 'first', path: '/repo-a' })
  expect(result.current.browsedRootPath).toBe('/tmp/reference')
  unmount()

  const remounted = renderHook(() =>
    useFileExplorerRootNavigation('first', '/', options, '/repo-a')
  )
  expect(remounted.result.current.browsedRootPath).toBeNull()
})

it('uses the existing folder picker to navigate', async () => {
  const pickDirectory = vi.mocked(window.api.repos.pickDirectory)
  pickDirectory.mockResolvedValue('/tmp/chosen')
  const { result } = renderHook(() => useFileExplorerRootNavigation('wt', '/', options, '/repo'))

  await act(() => result.current.openFolder())

  expect(result.current.browsedRootPath).toBe('/tmp/chosen')
})

it('preserves an existing sparse return target when returning back to workspace from a browsed folder', () => {
  const { result, rerender } = renderHook(
    ({ choice }) => useFileExplorerRootNavigation('wt', choice, options, '/repo'),
    { initialProps: { choice: 'app' } }
  )
  act(() => result.current.revealOutsideRoot())
  expect(actions.setExplorerDisplayRootForWorktree).toHaveBeenCalledWith('wt', '/')
  rerender({ choice: '/' })
  expect(result.current.returnRoot?.value).toBe('app')

  act(() => result.current.navigateToPath('/tmp/reference'))
  expect(result.current.browsedRootPath).toBe('/tmp/reference')
  expect(result.current.returnRoot).toBeNull()

  act(() => result.current.backToWorkspace())
  expect(result.current.browsedRootPath).toBeNull()
  expect(result.current.returnRoot?.value).toBe('app')
})

it('preserves a sparse return target when revealing an outside file while browsing outside', () => {
  const { result, rerender } = renderHook(
    ({ choice }) => useFileExplorerRootNavigation('wt', choice, options, '/repo'),
    { initialProps: { choice: 'app' } }
  )
  act(() => result.current.navigateToPath('/tmp/reference'))
  act(() => result.current.revealOutsideRoot())
  expect(actions.setExplorerDisplayRootForWorktree).toHaveBeenCalledWith('wt', '/')
  rerender({ choice: '/' })
  expect(result.current.returnRoot?.value).toBe('app')
})
