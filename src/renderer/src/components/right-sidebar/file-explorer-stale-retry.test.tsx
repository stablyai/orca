// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useFileExplorerTreeLoadEffects } from './use-file-explorer-tree-load-effects'
import {
  noteUserWorkspaceSwitch,
  resetWorkspaceSwitchUserActsForTests,
  WORKSPACE_SWITCH_MOUNT_WINDOW_MS
} from '@/lib/workspace-switch-user-act'

import { StrictMode, type PropsWithChildren } from 'react'
import { useAppStore } from '@/store'
import {
  initializeExplorerSubscriptions,
  useVisibleTree,
  visibleProps,
  listing
} from './file-explorer-lifecycle-test-support'

const read = vi.hoisted(() => vi.fn())
const stat = vi.hoisted(() => vi.fn())
vi.mock('@/lib/user-opened-local-path', () => ({ statUserOpenedPath: stat }))
vi.mock('@/components/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => async () => true
}))
vi.mock('./file-explorer-directory-listing', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  readFileExplorerDirectory: read
}))
const ownerMock = vi.hoisted(() => vi.fn())
const owner = vi.hoisted(() => ({
  kind: 'runtime' as const,
  environmentId: 'host-a',
  executionHostId: 'runtime:host-a' as const
}))
vi.mock('./file-explorer-operation-owner', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getFileExplorerOperationOwner: ownerMock,
  getFileExplorerOperationOwnerFromState: ownerMock
}))

afterEach(() => {
  cleanup()
  resetWorkspaceSwitchUserActsForTests()
})
function params() {
  return {
    props: {
      workspaceKey: 'repo-1::/repo',
      activeWorktreeId: 'repo-1::/repo',
      visibleFilesWorktreePath: '/repo',
      expanded: new Set<string>(),
      dirCache: {},
      loadingDirPaths: new Set<string>(),
      rootError: null,
      invalidateTree: vi.fn(),
      retireView: vi.fn(),
      reconcileView: vi.fn(),
      loadRevision: 0,
      resetAndLoad: vi.fn(),
      resetSelection: vi.fn(),
      setNameFilterQuery: vi.fn()
    }
  }
}
it("only the user's own switch to a workspace lets its open read start a stopped WSL distro", () => {
  const { props } = params()
  noteUserWorkspaceSwitch(props.workspaceKey)
  renderHook(useFileExplorerTreeLoadEffects, { initialProps: props })
  expect(props.resetAndLoad).toHaveBeenCalledExactlyOnceWith({ wakeWslDistro: true })
})
it('an old switch no consumer used is not redeemed by a later mount (E9)', () => {
  vi.useFakeTimers()
  try {
    const { props } = params()
    // The user switched here with the sidebar closed; the explorer mounts long after.
    noteUserWorkspaceSwitch(props.workspaceKey)
    vi.advanceTimersByTime(WORKSPACE_SWITCH_MOUNT_WINDOW_MS + 1)
    renderHook(useFileExplorerTreeLoadEffects, { initialProps: props })
    expect(props.resetAndLoad).toHaveBeenCalledExactlyOnceWith(undefined)
  } finally {
    vi.useRealTimers()
  }
})
it('a restore, remount or re-open with no new switch never wakes WSL', () => {
  const { props } = params()
  renderHook(useFileExplorerTreeLoadEffects, { initialProps: props })
  expect(props.resetAndLoad).toHaveBeenCalledExactlyOnceWith(undefined)

  noteUserWorkspaceSwitch(props.workspaceKey)
  const first = renderHook(useFileExplorerTreeLoadEffects, { initialProps: props })
  first.unmount()
  const remount = renderHook(useFileExplorerTreeLoadEffects, { initialProps: props })
  expect(props.resetAndLoad).toHaveBeenNthCalledWith(2, { wakeWslDistro: true })
  expect(props.resetAndLoad).toHaveBeenNthCalledWith(3, undefined)
  remount.unmount()
})

describe('visible tree wake provenance', () => {
  beforeEach(() => {
    resetWorkspaceSwitchUserActsForTests()
    initializeExplorerSubscriptions()
    vi.useFakeTimers()
    useAppStore.setState({
      expandedDirs: {},
      sshConnectedGeneration: 0,
      activeFileId: null,
      openFiles: [],
      pendingExplorerReveal: null
    })
    ownerMock.mockReturnValue(owner)
    read.mockReset().mockResolvedValue(listing('fresh.txt'))
    stat.mockReset().mockResolvedValue({ isDirectory: true, escapesWorktree: false })
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })
  const settle = () =>
    act(async () => {
      await vi.runAllTimersAsync()
    })
  function StrictWrapper({ children }: PropsWithChildren) {
    return <StrictMode>{children}</StrictMode>
  }
  function renderVisibleTree(strict = false) {
    noteUserWorkspaceSwitch('wt')
    const resetSelection = vi.fn()
    const setNameFilterQuery = vi.fn()
    return renderHook((props) => useVisibleTree(props, resetSelection, setNameFilterQuery, owner), {
      initialProps: visibleProps,
      wrapper: strict ? StrictWrapper : undefined
    })
  }
  function restore(paths: string[], id = 'wt') {
    act(() =>
      useAppStore.setState((state) => ({
        expandedDirs: { ...state.expandedDirs, [id]: new Set(paths) }
      }))
    )
  }

  it('opening wakes the root, background full refresh does not, and verified cache reuse adds no read', async () => {
    const hook = renderVisibleTree()
    await settle()
    expect(read).toHaveBeenCalledTimes(1)
    expect(read.mock.calls[0][3]?.wakeWslDistro).toBe(true)
    await act(async () => {
      await hook.result.current.loadDir('/repo/link', 0, { force: true, wakeWslDistro: true })
      hook.result.current.requestDir('/repo/link')
    })
    expect(read).toHaveBeenCalledTimes(2)
    restore(['/repo/link'])
    read.mockClear()
    await act(async () => {
      expect(await hook.result.current.refreshTree()).toBe('refreshed')
    })
    expect(read.mock.calls.map((call) => call[2])).toEqual(['/repo', '/repo/link'])
    expect(read.mock.calls.every((call) => !call[3]?.wakeWslDistro)).toBe(true)
  })
})
