// @vitest-environment happy-dom
import { StrictMode, type PropsWithChildren } from 'react'
import { act, cleanup, fireEvent, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useFileExplorerTree } from './useFileExplorerTree'
import { ORCA_WORKTREE_FILE_CHANGE_EVENT } from '@/hooks/worktree-file-change-event'
import { FILE_EXPLORER_RUNTIME_REFRESH_CONCURRENCY } from './file-explorer-refresh-concurrency'
import { useAppStore } from '@/store'
import {
  noteUserWorkspaceSwitch,
  resetWorkspaceSwitchUserActsForTests
} from '@/lib/workspace-switch-user-act'
import { applyFileExplorerNavigation } from './file-explorer-keyboard-navigation'
import type { TreeNode } from './file-explorer-types'
import {
  initializeExplorerSubscriptions,
  useVisibleTree,
  visibleProps,
  listing,
  gateRead,
  renderInteractionTree
} from './file-explorer-lifecycle-test-support'

vi.mock('./FileExplorerRow', () => ({
  FileExplorerRow: ({ node }: { node: TreeNode }) => (
    <button data-path={node.path}>{node.name}</button>
  )
}))

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
function emit(root = '/repo') {
  window.dispatchEvent(
    new CustomEvent(ORCA_WORKTREE_FILE_CHANGE_EVENT, {
      detail: {
        runtimeEnvironmentId: 'host-a',
        payload: {
          worktreePath: root,
          events: [{ kind: 'create', absolutePath: `${root}/new.txt`, isDirectory: false }]
        }
      }
    })
  )
}

it('stops a retired tree before its root response can launch expanded-directory reads', async () => {
  const gate = gateRead()
  read.mockReturnValueOnce(gate.promise)
  const hook = renderHook(() => useFileExplorerTree('/repo', new Set(['/repo/subdir']), 'wt'))
  let refresh!: ReturnType<typeof hook.result.current.refreshTree>
  act(() => {
    refresh = hook.result.current.refreshTree()
  })
  hook.unmount()
  expect(await refresh).toBe('superseded')
  expect(read).toHaveBeenCalledTimes(1)
})

it('cancels queued remote directory reads when an expanded refresh is retired', async () => {
  const gates = Array.from({ length: FILE_EXPLORER_RUNTIME_REFRESH_CONCURRENCY }, gateRead)
  read.mockImplementation((_id, _root, path) =>
    path === '/repo'
      ? Promise.resolve(listing())
      : (gates.shift()?.promise ?? Promise.resolve(listing()))
  )
  const pending = [...gates]
  const expanded = new Set(Array.from({ length: 20 }, (_, index) => `/repo/dir-${index}`))
  const hook = renderHook(() => useFileExplorerTree('/repo', expanded, 'wt'))
  let refresh!: ReturnType<typeof hook.result.current.refreshTree>
  await act(async () => {
    refresh = hook.result.current.refreshTree()
    await Promise.resolve()
  })
  expect(read).toHaveBeenCalledTimes(FILE_EXPLORER_RUNTIME_REFRESH_CONCURRENCY + 1)
  hook.unmount()
  expect(await refresh).toBe('superseded')
  for (const gate of pending) {
    gate.resolve(listing('obsolete.txt'))
  }
  expect(read).toHaveBeenCalledTimes(FILE_EXPLORER_RUNTIME_REFRESH_CONCURRENCY + 1)
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
const childPaths = (count: number) =>
  Array.from({ length: count }, (_, index) => `/repo/dir-${index}`)

it('restarts the initial read after StrictMode retires the first effect lifetime', async () => {
  const hook = renderVisibleTree(true)
  await act(async () => {
    await Promise.resolve()
  })
  expect(hook.result.current.rootCache?.children[0].name).toBe('fresh.txt')
  expect(hook.result.current.loadingDirPaths.size).toBe(0)
})

it.each(['no-event', 'pending', 'workspace', 'hidden-workspace'] as const)(
  'reconciles retained rows once after %s reentry',
  async (gap) => {
    read.mockResolvedValueOnce(listing('keep.txt', 'removed.txt', 'old-name.txt'))
    const hook = renderVisibleTree()
    await settle()
    act(() => hook.result.current.setSelected('/repo/keep.txt'))
    if (gap === 'pending' || gap === 'workspace') {
      act(() => emit())
    }
    const props = visibleProps
    hook.rerender({
      ...props,
      visible: gap === 'workspace',
      id: gap.endsWith('workspace') ? 'other-id' : 'wt'
    })
    const gate = gateRead()
    read.mockReturnValueOnce(gate.promise)
    hook.rerender(props)
    expect(hook.result.current.rootCache?.children.map((row) => row.name)).toEqual([
      'keep.txt',
      'removed.txt',
      'old-name.txt'
    ])
    await act(async () => gate.resolve(listing('keep.txt', 'new.txt', 'renamed.txt')))
    await settle()
    expect(hook.result.current.rootCache?.children.map((row) => row.name)).toEqual([
      'keep.txt',
      'new.txt',
      'renamed.txt'
    ])
    expect(hook.result.current.selected).toBe('/repo/keep.txt')
    expect(hook.result.current.resetSelection).toHaveBeenCalledTimes(1)
    expect(hook.result.current.setNameFilterQuery).toHaveBeenCalledTimes(1)
    expect(read.mock.calls.filter((call) => call[0] === 'wt')).toHaveLength(2)
    hook.rerender(props)
    await settle()
    expect(read.mock.calls.filter((call) => call[0] === 'wt')).toHaveLength(2)
  }
)

it('loads a new root once and isolates its old callbacks and blocked read', async () => {
  const gate = gateRead()
  read.mockReturnValueOnce(gate.promise)
  const hook = renderVisibleTree()
  act(() => emit())
  hook.rerender({ ...visibleProps, id: 'other', root: '/other', scope: '/other' })
  await settle()
  act(() => emit())
  await act(async () => gate.resolve(listing('obsolete.txt')))
  await settle()
  expect(read.mock.calls.map((call) => call[2])).toEqual(['/repo', '/other'])
  expect(hook.result.current.rootCache?.children[0].name).toBe('fresh.txt')
})

it.each([2, 20])(
  'verifies %i restored empty/nonempty directories once with bounded children on each route',
  async (count) => {
    for (const [route, cap] of [
      [{ kind: 'local' }, 16],
      [owner, 8],
      [{ kind: 'ssh', connectionId: 'ssh-a' }, 4]
    ] as const) {
      useAppStore.setState({ expandedDirs: {} })
      read.mockReset().mockResolvedValue(listing('fresh.txt'))
      ownerMock.mockReturnValue(route)
      const hook = renderVisibleTree()
      await settle()
      const dirs = childPaths(count)
      await act(async () => {
        for (const [index, path] of dirs.entries()) {
          read.mockResolvedValueOnce(index % 2 ? listing() : listing('old.txt'))
          await hook.result.current.loadDir(path, 0)
        }
      })
      hook.rerender({ ...visibleProps, visible: false })
      restore(dirs)
      const root = gateRead()
      let active = 0,
        peak = 0
      read.mockClear().mockImplementation((_id, _root, path) => {
        if (path === '/repo') {
          return root.promise
        }
        active++
        peak = Math.max(peak, active)
        return new Promise((resolve) =>
          setTimeout(() => {
            active--
            resolve(listing())
          }, 10)
        )
      })
      hook.rerender(visibleProps)
      expect(read).toHaveBeenCalledTimes(1)
      expect(hook.result.current.loadingDirPaths.has(dirs[0])).toBe(true)
      const queuedLoading = hook.result.current.loadingDirPaths
      hook.rerender(visibleProps)
      expect(hook.result.current.loadingDirPaths).toBe(queuedLoading)
      await act(async () => root.resolve(listing('new.txt')))
      await settle()
      expect(read).toHaveBeenCalledTimes(1 + count)
      expect(new Set(read.mock.calls.map((call) => call[2])).size).toBe(1 + count)
      expect(peak).toBe(Math.min(cap, count))
      expect(read.mock.calls.every((call) => !call[3]?.wakeWslDistro)).toBe(true)
      const loading = hook.result.current.loadingDirPaths
      hook.rerender(visibleProps)
      await settle()
      expect(hook.result.current.loadingDirPaths).toBe(loading)
      expect(read).toHaveBeenCalledTimes(1 + count)
      hook.unmount()
    }
  }
)

it.each(['old-first', 'retry-first'] as const)(
  'root-only Retry drains children with obsolete root held: %s',
  async (order) => {
    const hook = renderVisibleTree()
    await settle()
    await act(async () => {
      await hook.result.current.loadDir('/repo/dir', 0)
    })
    restore(['/repo/dir'])
    hook.rerender({ ...visibleProps, visible: false })
    const old = gateRead(),
      retry = gateRead()
    read
      .mockClear()
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(retry.promise)
      .mockResolvedValue(listing('current.txt'))
    hook.rerender(visibleProps)
    let pending!: Promise<void>
    act(() => {
      pending = hook.result.current.refreshDir('/repo', { wakeWslDistro: true })
    })
    if (order === 'old-first') {
      await act(async () => old.resolve(listing('obsolete.txt')))
    }
    expect(hook.result.current.loadingDirPaths.has('/repo')).toBe(true)
    await act(async () => {
      retry.resolve(listing('root-current.txt'))
      await pending
    })
    await settle()
    expect(hook.result.current.dirCache['/repo/dir'].children[0].name).toBe('current.txt')
    expect(read.mock.calls.map((call) => [call[2], !!call[3]?.wakeWslDistro])).toEqual([
      ['/repo', false],
      ['/repo', true],
      ['/repo/dir', false]
    ])
    await act(async () => old.resolve(listing('obsolete.txt')))
    expect(hook.result.current.rootCache?.children[0].name).toBe('root-current.txt')
    expect(hook.result.current.isDirStale('/repo/dir')).toBe(false)
  }
)

it('rederives current missing, stale and scoped demand during root and child phases', async () => {
  const hook = renderVisibleTree()
  await settle()
  await act(async () => {
    await hook.result.current.loadDir('/repo/collapsed', 0)
  })
  hook.rerender({ ...visibleProps, visible: false })
  const root = gateRead(),
    child = gateRead()
  read
    .mockClear()
    .mockImplementation((_id, _root, path) =>
      path === '/repo'
        ? root.promise
        : path === '/repo/early'
          ? child.promise
          : Promise.resolve(listing())
    )
  hook.rerender(visibleProps)
  restore(['/repo/early'])
  hook.rerender({ ...visibleProps, scope: '/repo/scope' })
  expect(read).toHaveBeenCalledTimes(1)
  await act(async () => root.resolve(listing('current.txt')))
  expect(read.mock.calls.map((call) => call[2]).sort()).toEqual([
    '/repo',
    '/repo/early',
    '/repo/scope'
  ])
  restore(['/repo/early', '/repo/late', '/repo/collapsed'])
  hook.rerender({ ...visibleProps, scope: '/repo/late' })
  await settle()
  expect(read.mock.calls.filter((call) => call[2] === '/repo/late')).toHaveLength(1)
  expect(hook.result.current.dirCache['/repo/collapsed'].children).toEqual([])
  await act(async () => child.resolve(listing()))
  await settle()
  expect(read).toHaveBeenCalledTimes(5)
})

it.each(
  ['root', 'scope', 'child'].flatMap((failure) =>
    ['', 'offline'].map((message) => [failure, message])
  )
)(
  'terminates a failed %s attempt (%j) and permits a new authoritative attempt',
  async (failure, message) => {
    const hook = renderVisibleTree()
    await settle()
    hook.rerender({ ...visibleProps, visible: false })
    restore(['/repo/scope', '/repo/scope/child'])
    const failedPath =
      failure === 'root' ? '/repo' : failure === 'scope' ? '/repo/scope' : '/repo/scope/child'
    const unexpectedRepeat = gateRead()
    let attempts = 0
    read.mockClear().mockImplementation((_id, _root, path) => {
      if (path !== failedPath) {
        return Promise.resolve(listing())
      }
      // Hold a regressed second dispatch so the red test cannot spin on repeated rejection.
      return ++attempts === 1 ? Promise.reject(new Error(message)) : unexpectedRepeat.promise
    })
    hook.rerender({ ...visibleProps, scope: '/repo/scope' })
    await settle()
    const count = read.mock.calls.length
    expect(read.mock.calls.filter((call) => call[2] === failedPath)).toHaveLength(1)
    if (failure === 'root') {
      expect(count).toBe(1)
    }
    if (failure === 'scope') {
      expect(read.mock.calls.some((call) => call[2] === '/repo/scope/child')).toBe(false)
    }
    hook.rerender({ ...visibleProps, scope: '/repo/scope' })
    await settle()
    expect(read).toHaveBeenCalledTimes(count)
    read.mockResolvedValue(listing('recovered.txt'))
    hook.rerender({ ...visibleProps, visible: false })
    hook.rerender({ ...visibleProps, scope: '/repo/scope' })
    await settle()
    expect(hook.result.current.dirCache[failedPath].error).toBeUndefined()
  }
)

it.each([
  ['root', 'hide'],
  ['root', 'workspace'],
  ['children', 'hide'],
  ['children', 'workspace']
] as const)(
  'retires held %s on %s without dispatching old queued work',
  async (phase, transition) => {
    const hook = renderVisibleTree()
    await settle()
    restore(childPaths(20))
    await settle()
    const held = gateRead(),
      replacement = gateRead()
    read
      .mockClear()
      .mockImplementation((_id, _root, path) =>
        path === '/repo' && phase === 'children'
          ? Promise.resolve(listing('root.txt'))
          : held.promise
      )
    let old!: Promise<unknown>
    await act(async () => {
      old = hook.result.current.refreshTree()
      await Promise.resolve()
    })
    const oldCount = read.mock.calls.length
    expect(oldCount).toBe(phase === 'root' ? 1 : 9)
    read.mockImplementation(() => replacement.promise)
    hook.rerender(
      transition === 'hide'
        ? { ...visibleProps, visible: false }
        : { ...visibleProps, id: 'new-owner' }
    )
    expect(await old).toBe('superseded')
    if (transition === 'hide') {
      expect(hook.result.current.loadingDirPaths.size).toBe(0)
    }
    hook.rerender({ ...visibleProps, id: 'new-owner' })
    await act(async () => held.resolve(listing('obsolete.txt')))
    expect(read).toHaveBeenCalledTimes(oldCount + 1)
    expect(hook.result.current.loadingDirPaths.has('/repo')).toBe(true)
    read.mockResolvedValue(listing('current.txt'))
    await act(async () => replacement.resolve(listing('current-root.txt')))
    await settle()
    expect(hook.result.current.rootCache?.children[0].name).toBe('current-root.txt')
  }
)

it('a new explicit claim survives retired child cleanup and publishes while automatic rows are protected', async () => {
  const hook = renderVisibleTree()
  await settle()
  restore(['/repo/a'])
  await settle()
  const old = gateRead(),
    explicit = gateRead()
  read
    .mockClear()
    .mockImplementation((_id, _root, path) =>
      path === '/repo' ? Promise.resolve(listing('root.txt')) : old.promise
    )
  let full!: Promise<unknown>
  await act(async () => {
    full = hook.result.current.refreshTree()
    await Promise.resolve()
  })
  read.mockReturnValueOnce(explicit.promise)
  act(() => {
    hook.result.current.requestDir('/repo/a')
    hook.result.current.setNative(true)
  })
  hook.rerender({ ...visibleProps, visible: false })
  expect(await full).toBe('superseded')
  hook.rerender(visibleProps)
  read.mockReturnValueOnce(explicit.promise)
  act(() => hook.result.current.requestDir('/repo/a'))
  await act(async () => old.resolve(listing('obsolete.txt')))
  expect(hook.result.current.loadingDirPaths.has('/repo/a')).toBe(true)
  await act(async () => explicit.resolve(listing('explicit.txt')))
  expect(hook.result.current.dirCache['/repo/a'].children[0].name).toBe('explicit.txt')
})

it.each(['mouse', 'keyboard', 'internal-hover', 'native-hover', 'file', 'folder'] as const)(
  'starts %s directory requests during interaction and a failed no-wake root',
  async (gesture) => {
    const directories = {
      ...listing(),
      entries: ['a', 'b', 'after-error'].map((name) => ({
        name,
        isDirectory: true,
        isSymlink: false
      }))
    }
    read.mockResolvedValueOnce(directories)
    const hook = renderVisibleTree()
    await settle()
    const a = gateRead(),
      root = gateRead()
    read.mockImplementation((_id, _root, path) =>
      path === '/repo'
        ? root.promise
        : path === '/repo/a'
          ? a.promise
          : Promise.resolve(listing('requested.txt'))
    )
    hook.rerender({ ...visibleProps, visible: false })
    hook.rerender(visibleProps)
    read.mockClear()
    act(() => {
      hook.result.current.requestDir('/repo/a')
      hook.result.current.setNative(true)
    })
    const node = hook.result.current.rootCache!.children[1]
    act(() => {
      const current = hook.result.current
      if (gesture === 'mouse') {
        current.handlers.handleClick(node)
      } else if (gesture === 'keyboard') {
        applyFileExplorerNavigation(
          {
            rowProjection: current.projection,
            activeWorktreeId: 'wt',
            selectedNode: node,
            isExpanded: (path) => current.expanded.has(path),
            findFocusedIndex: () => null,
            handlers: {
              toggleDir: current.toggleDir,
              moveSelection: vi.fn(),
              scrollToIndex: vi.fn(),
              focusRowAtIndex: vi.fn()
            }
          },
          new KeyboardEvent('keydown', { key: 'ArrowRight' })
        )
      } else if (gesture === 'internal-hover') {
        current.hover.handleDragExpandDir(node.path)
      } else if (gesture === 'native-hover') {
        current.hover.handleNativeDragExpandDir(node.path)
      } else {
        current.input.startNew(gesture, node.path, 1)
      }
    })
    await settle()
    expect(hook.result.current.dirCache['/repo/b'].children[0].name).toBe('requested.txt')
    expect(read.mock.calls.filter((call) => call[2] === '/repo/b')).toHaveLength(1)
    expect(read.mock.calls.every((call) => call[3]?.wakeWslDistro === true)).toBe(true)
    await act(async () => root.reject(new Error('stopped distro')))
    act(() => {
      hook.result.current.setNative(false)
      hook.result.current.input.dismissInlineInput()
    })
    await settle()
    // A different real expansion still works after failure; background restoration remains suppressed.
    act(() => hook.result.current.hover.handleNativeDragExpandDir('/repo/after-error'))
    await settle()
    expect(hook.result.current.dirCache['/repo/after-error'].children[0].name).toBe('requested.txt')
    await act(async () => a.resolve(listing('a.txt')))
  }
)

it('a real opening supersedes a competing no-wake read instead of inheriting its failure', async () => {
  read.mockResolvedValueOnce({
    ...listing(),
    entries: [{ name: 'folder', isDirectory: true, isSymlink: false }]
  })
  const hook = renderVisibleTree()
  await settle()
  const old = gateRead(),
    user = gateRead()
  read.mockClear().mockReturnValueOnce(old.promise).mockReturnValueOnce(user.promise)
  restore(['/repo/folder'])
  expect(read.mock.calls[0][3]?.wakeWslDistro).toBeUndefined()
  // Collapse/open is a new input while the old automatic listing is still held.
  act(() => {
    hook.result.current.toggleDir('wt', '/repo/folder')
    hook.result.current.toggleDir('wt', '/repo/folder')
  })
  expect(read.mock.calls[1][3]?.wakeWslDistro).toBe(true)
  await act(async () => old.reject(new Error('asleep')))
  expect(hook.result.current.loadingDirPaths.has('/repo/folder')).toBe(true)
  await act(async () => user.resolve(listing('awake.txt')))
  expect(hook.result.current.dirCache['/repo/folder'].error).toBeUndefined()
  expect(hook.result.current.dirCache['/repo/folder'].children[0].name).toBe('awake.txt')
})

it('independent actual folder requests start before an unrelated SSH read settles', async () => {
  ownerMock.mockReturnValue({ kind: 'ssh', connectionId: 'ssh-a' })
  const hook = renderVisibleTree()
  await settle()
  const held = gateRead()
  read
    .mockClear()
    .mockImplementation((_id, _root, path) =>
      path === '/repo/a' ? held.promise : Promise.resolve(listing('b.txt'))
    )
  act(() => hook.result.current.hover.handleDragExpandDir('/repo/a'))
  act(() => hook.result.current.hover.handleDragExpandDir('/repo/b'))
  await settle()
  expect(read.mock.calls.map((call) => call[2])).toEqual(['/repo/a', '/repo/b'])
  expect(hook.result.current.dirCache['/repo/b'].children[0].name).toBe('b.txt')
  expect(hook.result.current.loadingDirPaths.has('/repo/a')).toBe(true)
  await act(async () => held.resolve(listing('a.txt')))
})

it('scope Retry admits current work while its obsolete scoped read remains held', async () => {
  const hook = renderVisibleTree()
  await settle()
  const old = gateRead(),
    retry = gateRead()
  read
    .mockClear()
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(retry.promise)
    .mockResolvedValue(listing())
  hook.rerender({ ...visibleProps, scope: '/repo/scope' })
  restore(['/repo/scope/child'])
  let pending!: Promise<void>
  act(() => {
    pending = hook.result.current.refreshDir('/repo/scope', { wakeWslDistro: true })
  })
  await act(async () => {
    retry.resolve(listing('current.txt'))
    await pending
  })
  await settle()
  expect(hook.result.current.dirCache['/repo/scope/child'].operationOwner).toBeDefined()
  await act(async () => old.resolve(listing('obsolete.txt')))
  expect(hook.result.current.dirCache['/repo/scope'].children[0].name).toBe('current.txt')
})

it.each(
  ['rename', 'internal-drag', 'native-drag'].flatMap((interaction) =>
    ['reveal', 'precise'].map((source) => [interaction, source] as const)
  )
)(
  'protects rendered %s from successful %s replacement and drains after release',
  async (interaction, source) => {
    read.mockResolvedValue(listing('edited.txt', 'sibling.txt'))
    const current = renderInteractionTree(owner)
    await settle()
    const root = gateRead()
    read
      .mockClear()
      .mockReturnValueOnce(root.promise)
      .mockResolvedValue(listing('renamed.txt', 'new-sibling.txt'))
    act(() => {
      if (source === 'reveal') {
        current().invalidateTree()
      } else {
        void current().refreshDir('/repo')
      }
    })
    expect(read).toHaveBeenCalledTimes(1)
    act(() => {
      if (interaction === 'rename') {
        current().input.startRename(current().rootCache!.children[0])
      } else if (interaction === 'internal-drag') {
        current().setDrag('/repo/edited.txt')
      } else {
        current().setNative(true)
      }
    })
    if (interaction === 'native-drag') {
      expect(current().native).toBe(true)
    }
    if (interaction === 'rename') {
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'typed-draft.txt' } })
    }
    await act(async () => root.resolve(listing('renamed.txt', 'new-sibling.txt')))
    await settle()
    expect(read).toHaveBeenCalledTimes(1)
    if (interaction === 'rename') {
      expect(screen.getByRole('textbox')).toHaveProperty('value', 'typed-draft.txt')
    } else {
      expect(screen.getByText('edited.txt')).toBeTruthy()
    }
    expect(screen.getByText('sibling.txt')).toBeTruthy()
    expect(screen.queryByText('new-sibling.txt')).toBeNull()
    act(() => {
      current().input.dismissInlineInput()
      current().setDrag(null)
      current().setNative(false)
    })
    await settle()
    expect(screen.getByText('renamed.txt')).toBeTruthy()
    expect(screen.getByText('new-sibling.txt')).toBeTruthy()
    expect(read).toHaveBeenCalledTimes(2)
    expect(read.mock.calls.every((call) => !call[3]?.wakeWslDistro)).toBe(true)
  }
)

it.each(
  ['single', 'wave'].flatMap((source) =>
    ['rename', 'internal-drag', 'native-drag'].map((interaction) => [source, interaction])
  )
)(
  'settles protected failed opened-link cleanup after %s/%s and reactivates the restored target',
  async (source, interaction) => {
    const rootListing = {
      ...listing(),
      entries: [{ name: 'link', isDirectory: false, isSymlink: true }]
    }
    read.mockImplementation((_id, _root, path) =>
      Promise.resolve(path === '/repo' ? rootListing : listing('old.txt'))
    )
    const current = renderInteractionTree(owner)
    await settle()
    act(() => current().handlers.handleClick(current().rootCache!.children[0]))
    await settle()
    expect(current().rootCache!.children[0].isDirectoryFromOpenedLink).toBe(true)
    const held = gateRead()
    read
      .mockClear()
      .mockImplementation((_id, _root, path) =>
        path === '/repo' ? Promise.resolve(rootListing) : held.promise
      )
    act(() => {
      if (source === 'single') {
        void current().refreshDir('/repo/link')
      } else {
        current().invalidateTree()
      }
    })
    await settle()
    act(() => {
      if (interaction === 'rename') {
        current().input.startRename(current().rootCache!.children[0])
      } else if (interaction === 'internal-drag') {
        current().setDrag('/repo/link')
      } else {
        current().setNative(true)
      }
    })
    if (interaction === 'native-drag') {
      expect(current().native).toBe(true)
    }
    if (interaction === 'rename') {
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'link-draft' } })
    }
    await act(async () => held.reject(new Error('ENOTDIR')))
    await settle()
    expect(current().dirCache['/repo/link'].error).toBe('ENOTDIR')
    expect(current().rootCache!.children[0].isDirectoryFromOpenedLink).toBe(true)
    if (interaction === 'rename') {
      expect(screen.getByRole('textbox')).toHaveProperty('value', 'link-draft')
    } else {
      expect(screen.getByText('link')).toBeTruthy()
    }
    const attempts = read.mock.calls.length
    act(() => {
      current().input.dismissInlineInput()
      current().setDrag(null)
      current().setNative(false)
    })
    await settle()
    expect(current().rootCache!.children[0].isDirectory).toBe(false)
    expect(read).toHaveBeenCalledTimes(attempts)
    act(() => useAppStore.getState().toggleDir('wt', '/repo/link'))
    read.mockResolvedValue(listing('recovered.txt'))
    stat.mockClear()
    act(() => current().handlers.handleClick(current().rootCache!.children[0]))
    await settle()
    expect(stat).toHaveBeenCalledTimes(1)
    expect(screen.getByText('recovered.txt')).toBeTruthy()
    expect(current().dirCache['/repo/link'].error).toBeUndefined()
    expect(read).toHaveBeenCalledTimes(attempts + 1)
  }
)

it('interaction admission stops queued automatic children and replacement still drains them', async () => {
  const hook = renderVisibleTree()
  await settle()
  restore(childPaths(20))
  await settle()
  const held = gateRead()
  read
    .mockClear()
    .mockImplementation((_id, _root, path) =>
      path === '/repo' ? Promise.resolve(listing()) : held.promise
    )
  act(() => hook.result.current.invalidateTree())
  await act(async () => {
    await Promise.resolve()
  })
  expect(read).toHaveBeenCalledTimes(9)
  act(() => hook.result.current.setDrag('/repo/source.txt'))
  await act(async () => held.resolve(listing('blocked.txt')))
  await settle()
  expect(read).toHaveBeenCalledTimes(9)
  read.mockResolvedValue(listing('drained.txt'))
  act(() => hook.result.current.setDrag(null))
  await settle()
  expect(read).toHaveBeenCalledTimes(29)
  expect(
    childPaths(20).every(
      (path) => hook.result.current.dirCache[path].children[0].name === 'drained.txt'
    )
  ).toBe(true)
})

it('New File loads its requested parent while the rendered creation draft stays typed', async () => {
  read.mockResolvedValueOnce({
    ...listing(),
    entries: [{ name: 'folder', isDirectory: true, isSymlink: false }]
  })
  const current = renderInteractionTree(owner)
  await settle()
  const parent = gateRead()
  read.mockClear().mockReturnValueOnce(parent.promise)
  act(() => current().input.startNew('file', '/repo/folder', 1))
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'new-draft.txt' } })
  const input = screen.getByRole('textbox')
  expect(read.mock.calls[0][3]?.wakeWslDistro).toBe(true)
  await act(async () => parent.resolve(listing('existing-child.txt')))
  expect(screen.getByText('existing-child.txt')).toBeTruthy()
  expect(screen.getByRole('textbox')).toBe(input)
  expect(input).toHaveProperty('value', 'new-draft.txt')
  expect(read).toHaveBeenCalledTimes(1)
})
