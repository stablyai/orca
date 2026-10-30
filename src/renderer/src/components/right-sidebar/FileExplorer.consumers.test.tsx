// @vitest-environment happy-dom
import type * as Module0 from '@/runtime/runtime-file-mutation-client'
import type * as Module1 from '@/runtime/runtime-file-metadata-client'
import type * as Module2 from '@/runtime/runtime-file-read-client'
import type { ComponentProps } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import FileExplorer from './FileExplorer'
import type { FileExplorerFilesTreePane } from './FileExplorerFilesTreePane'
import type { FileExplorerToolbar } from './FileExplorerToolbar'
import { useAppStore } from '@/store'
import { undoFileExplorer, redoFileExplorer } from './fileExplorerUndoRedo'
import { gateRead, initializeExplorerSubscriptions } from './file-explorer-lifecycle-test-support'

const disk = vi.hoisted(() => new Map<string, boolean>())
const read = vi.hoisted(() => vi.fn())
let current!: ComponentProps<typeof FileExplorerFilesTreePane>
let toolbar!: ComponentProps<typeof FileExplorerToolbar>
vi.mock('./FileExplorerFilesTreePane', () => ({
  FileExplorerFilesTreePane: (props: typeof current) => {
    current = props
    return (
      <div ref={props.paneState.fileDropOwnerRef}>
        {props.rowProjection.getOrderedPaths().map((path) => (
          <span key={path} data-testid={path}>
            {path}
          </span>
        ))}
      </div>
    )
  }
}))
vi.mock('./FileExplorerToolbar', () => ({
  FileExplorerToolbar: (props: typeof toolbar) => {
    toolbar = props
    return null
  }
}))
vi.mock('./FileExplorerBackgroundMenu', () => ({ FileExplorerBackgroundMenu: () => null }))
vi.mock('./FileExplorerNameFilter', () => ({ FileExplorerNameFilter: () => null }))
vi.mock('./SearchQueryRow', () => ({ SearchQueryRow: () => null }))
vi.mock('./SearchFilters', () => ({ SearchFilters: () => null }))
vi.mock('./SearchResultsPane', () => ({ SearchResultsPane: () => null }))
vi.mock('./useFileSearchPanel', () => ({
  useFileSearchPanel: () => ({
    activeWorktreeId: null,
    queryRowProps: {},
    filtersProps: {},
    resultsProps: {}
  })
}))
vi.mock('@/components/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => async () => true
}))
vi.mock('@/lib/execute-open-editor-path-move', () => ({
  executeOpenEditorPathMove: async ({ fromPath, toPath }: { fromPath: string; toPath: string }) => {
    disk.set(toPath, disk.get(fromPath) ?? false)
    disk.delete(fromPath)
  }
}))
vi.mock('@/runtime/runtime-file-mutation-client', async (original) => ({
  ...(await original<typeof Module0>()),
  readRuntimeDirectory: read,
  createRuntimePath: async (_context: unknown, path: string, kind: string) => {
    disk.set(path, kind === 'directory')
  },
  deleteRuntimePath: async (_context: unknown, path: string) => {
    disk.delete(path)
  },
  copyRuntimePath: async (_context: unknown, from: string, to: string) => {
    disk.set(to, disk.get(from) ?? false)
  },
  writeRuntimeFile: async (_context: unknown, path: string) => {
    disk.set(path, false)
    return { ok: true }
  }
}))
vi.mock('@/runtime/runtime-file-metadata-client', async (original) => ({
  ...(await original<typeof Module1>()),
  runtimePathExists: async (_context: unknown, path: string) => disk.has(path)
}))
vi.mock('@/runtime/runtime-file-read-client', async (original) => ({
  ...(await original<typeof Module2>()),
  readRuntimeFileContent: async () => ({ content: 'saved', isBinary: false })
}))
vi.mock('@/runtime/runtime-file-import-client', () => ({
  importExternalPathsToRuntime: async (
    _context: unknown,
    _sources: string[],
    destination: string
  ) => {
    const path = `${destination}/imported.txt`
    disk.set(path, false)
    return { results: [{ status: 'imported', destPath: path }] }
  }
}))
const initial = useAppStore.getInitialState()
const settle = () =>
  act(async () => {
    await vi.runAllTimersAsync()
  })
beforeEach(() => {
  initializeExplorerSubscriptions()
  vi.useFakeTimers()
  disk.clear()
  disk.set('/repo/folder', true)
  disk.set('/repo/old.txt', false)
  useAppStore.setState(initial, true)
  useAppStore.setState({
    activeWorktreeId: 'folder:fixture',
    activeWorkspaceExecutionHostId: 'local',
    rightSidebarOpen: true,
    rightSidebarExplorerView: 'files',
    folderWorkspaces: [
      {
        id: 'fixture',
        projectGroupId: 'group',
        name: 'Fixture',
        folderPath: '/repo',
        executionHostId: 'local',
        connectionId: null,
        linkedTask: null,
        comment: '',
        isArchived: false,
        isUnread: false,
        isPinned: false,
        sortOrder: 0,
        lastActivityAt: 0,
        createdAt: 0,
        updatedAt: 0
      }
    ],
    projectGroups: [
      {
        id: 'group',
        name: 'Fixture',
        parentPath: '/',
        parentGroupId: null,
        createdFrom: 'manual',
        tabOrder: 0,
        isCollapsed: false,
        color: null,
        executionHostId: 'local',
        connectionId: null,
        createdAt: 0,
        updatedAt: 0
      }
    ]
  })
  read.mockReset().mockImplementation(async (_context, directory) =>
    [...disk]
      .filter(([path]) => path.slice(0, path.lastIndexOf('/')) === directory)
      .map(([path, isDirectory]) => ({
        name: path.slice(path.lastIndexOf('/') + 1),
        isDirectory,
        isSymlink: false
      }))
  )
})
afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('uses the pane gesture, reveals a pending file to selection/scroll, and completes manual refresh', async () => {
  render(<FileExplorer />)
  await settle()
  disk.set('/repo/folder/target.txt', false)
  const held = gateRead()
  read.mockImplementationOnce(() => held.promise.then((value) => value.entries))
  act(() =>
    current.paneState.handlers.handleClick(
      current.tree.rootCache!.children.find((node) => node.name === 'folder')!
    )
  )
  expect(read.mock.calls.at(-1)?.[2]?.wakeWslDistro).toBe(true)
  const scroll = vi.spyOn(current.paneState.rowScrolling.virtualizer, 'scrollToIndex')
  act(() =>
    useAppStore.setState({
      pendingExplorerReveal: {
        worktreeId: 'folder:fixture',
        filePath: '/repo/folder/target.txt',
        requestId: 1,
        origin: 'manual',
        flash: false
      }
    })
  )
  await act(async () =>
    held.resolve({
      entries: [{ name: 'target.txt', isDirectory: false, isSymlink: false }],
      operationOwner: {
        kind: 'runtime',
        environmentId: 'host-a',
        executionHostId: 'runtime:host-a'
      }
    })
  )
  await settle()
  expect(screen.getByTestId('/repo/folder/target.txt')).toBeTruthy()
  expect(current.selection.selectedPath).toBe('/repo/folder/target.txt')
  expect(scroll).toHaveBeenCalledWith(
    current.rowProjection.getIndexByPath('/repo/folder/target.txt'),
    { align: 'center' }
  )
  expect(useAppStore.getState().pendingExplorerReveal).toBeNull()
  disk.set('/repo/manual.txt', false)
  act(() => toolbar.refresh.handleRefresh())
  expect(toolbar.refresh.isRefreshing).toBe(true)
  await settle()
  expect(toolbar.refresh.isRefreshing).toBe(false)
  expect(screen.getByTestId('/repo/manual.txt')).toBeTruthy()
})

it('remounts the actual same-path pane when the selected owner changes and rejects old publication', async () => {
  const old = gateRead()
  read.mockImplementationOnce(() => old.promise.then((value) => value.entries))
  render(<FileExplorer />)
  const oldLoader = current.tree.loadDir
  read.mockResolvedValueOnce([{ name: 'new-host.txt', isDirectory: false, isSymlink: false }])
  act(() =>
    useAppStore.setState((state) => ({
      activeWorkspaceExecutionHostId: 'ssh:box' as const,
      folderWorkspaces: state.folderWorkspaces.map((folder) => ({
        ...folder,
        executionHostId: 'ssh:box' as const,
        connectionId: 'box'
      })),
      projectGroups: state.projectGroups.map((group) => ({
        ...group,
        executionHostId: 'ssh:box' as const,
        connectionId: 'box'
      }))
    }))
  )
  await settle()
  expect(current.tree.loadDir).not.toBe(oldLoader)
  await act(async () =>
    old.resolve({
      entries: [{ name: 'old-host.txt', isDirectory: false, isSymlink: false }],
      operationOwner: {
        kind: 'runtime',
        environmentId: 'host-a',
        executionHostId: 'runtime:host-a'
      }
    })
  )
  await settle()
  expect(screen.getByTestId('/repo/new-host.txt')).toBeTruthy()
  expect(screen.queryByTestId('/repo/old-host.txt')).toBeNull()
  expect(read).toHaveBeenCalledTimes(2)
})

it.each(['create', 'rename', 'move', 'delete', 'duplicate', 'import'])(
  'publishes %s through the actual pane consumer and refreshed rows',
  async (operation) => {
    render(<FileExplorer />)
    await settle()
    const old = current.tree.rootCache!.children.find((node) => node.name === 'old.txt')!
    const expected =
      operation === 'create'
        ? '/repo/created'
        : operation === 'rename'
          ? '/repo/renamed.txt'
          : operation === 'move'
            ? '/repo/folder/old.txt'
            : operation === 'duplicate'
              ? '/repo/old copy.txt'
              : '/repo/imported.txt'
    if (operation === 'move') {
      act(() => current.paneState.handlers.handleClick(current.tree.rootCache!.children[0]))
      await settle()
    }
    act(() => current.selection.setSingleSelectedPath(old.path))
    act(() => {
      if (operation === 'create') {
        current.paneState.inlineInputState.startNew('folder', '/repo', 0)
      } else if (operation === 'rename') {
        current.paneState.inlineInputState.startRename(old)
      } else if (operation === 'move') {
        current.paneState.dragDrop.handleMoveDrop(old.path, '/repo/folder')
      } else if (operation === 'delete') {
        current.paneState.deletion.requestDelete(old)
      } else if (operation === 'duplicate') {
        current.paneState.nodeCommands.handleDuplicate(old)
      }
    })
    if (operation === 'create' || operation === 'rename') {
      act(() =>
        current.paneState.inlineInputState.handleInlineSubmit(
          operation === 'create' ? 'created' : 'renamed.txt'
        )
      )
    }
    if (operation === 'import') {
      vi.stubGlobal('api', {
        ...window.api,
        fs: {
          ...window.api.fs,
          getPathForFile: () => '/outside/imported.txt',
          prepareDroppedPaths: async ({ paths }: { paths: string[] }) => ({ paths, failures: [] })
        }
      })
      const target = screen.getByTestId('/repo/old.txt')
      for (const type of ['dragover', 'drop']) {
        const event = new Event(type, { bubbles: true, cancelable: true, composed: true })
        Object.defineProperties(event, {
          dataTransfer: {
            value: {
              types: ['Files'],
              files: [new File(['a'], 'imported.txt')],
              dropEffect: 'copy'
            }
          },
          isTrusted: { value: true }
        })
        target.dispatchEvent(event)
      }
    }
    await settle()
    if (operation === 'delete') {
      expect(screen.queryByTestId('/repo/old.txt')).toBeNull()
      expect(current.selection.selectedPath).toBeNull()
    } else {
      expect(screen.getByTestId(expected)).toBeTruthy()
    }
    if (operation === 'rename' || operation === 'move') {
      expect(screen.queryByTestId('/repo/old.txt')).toBeNull()
    }
    if (operation === 'import') {
      expect(current.selection.selectedPath).toBe(expected)
    }
    if (['create', 'rename', 'move', 'delete'].includes(operation)) {
      await act(async () => {
        expect(await undoFileExplorer()).toBe(true)
      })
      await settle()
      expect(screen.getByTestId('/repo/old.txt')).toBeTruthy()
      if (operation !== 'delete') {
        expect(screen.queryByTestId(expected)).toBeNull()
      }
      await act(async () => {
        expect(await redoFileExplorer()).toBe(true)
      })
      await settle()
      if (operation === 'delete') {
        expect(screen.queryByTestId('/repo/old.txt')).toBeNull()
      } else {
        expect(screen.getByTestId(expected)).toBeTruthy()
      }
    }
  }
)
