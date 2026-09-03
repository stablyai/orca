// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { DirEntry } from '../../../../shared/filesystem-entry-types'
import { FileExplorerRow } from './FileExplorerRow'
import { FileExplorerVirtualRows } from './FileExplorerVirtualRows'
import { createFileExplorerRowProjection } from './file-explorer-row-projection'
import { directoryNode } from './file-explorer-tree-node-test-fixtures'
import { visit, type ReactElementLike } from './file-explorer-element-tree-test-harness'
import { useFileExplorerTree } from './useFileExplorerTree'
import { useFileExplorerVisibleRowProjection } from './useFileExplorerVisibleRowProjection'

const readDirectoryMock = vi.hoisted(() => vi.fn())
vi.mock('./file-explorer-directory-listing', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readFileExplorerDirectory: readDirectoryMock
}))
vi.mock('./file-explorer-operation-owner', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getFileExplorerOperationOwner: () => ({ kind: 'local' as const })
}))
vi.mock('@/runtime/runtime-git-client', () => ({
  getRuntimeGitIgnoredPaths: vi.fn().mockResolvedValue([])
}))

const initialAppState = useAppStore.getInitialState()
const WORKTREE_PATH = '/repo'
const SRC_DIR = '/repo/src'

function entry(name: string, isDirectory = false): DirEntry {
  return { name, isDirectory } as DirEntry
}

function listing(...entries: DirEntry[]) {
  return { entries, operationOwner: { kind: 'local' as const } }
}

function useTreeWithProjection(expanded: Set<string>) {
  const tree = useFileExplorerTree(WORKTREE_PATH, expanded, 'wt-1')
  const projection = useFileExplorerVisibleRowProjection(
    'wt-1',
    WORKTREE_PATH,
    tree.dirCache,
    expanded,
    false,
    true,
    null
  )
  return { tree, rowProjection: projection.rowProjection }
}

/** Counts how many times the memoized visible-row projection produced a new value. */
function renderTreeWithProjectionRebuildCounter(expanded: Set<string>): {
  result: { current: ReturnType<typeof useTreeWithProjection> }
  rebuilds: () => number
} {
  const seen = new Set<unknown>()
  const hook = renderHook(() => {
    const value = useTreeWithProjection(expanded)
    seen.add(value.rowProjection)
    return value
  })
  return { result: hook.result, rebuilds: () => seen.size }
}

/** Holds the next directory read open so the loading commit lands in its own render. */
function gateNextRead(): { resolve: (value: ReturnType<typeof listing>) => void } {
  let resolve!: (value: ReturnType<typeof listing>) => void
  const gate = new Promise<ReturnType<typeof listing>>((nextResolve) => {
    resolve = nextResolve
  })
  readDirectoryMock.mockImplementationOnce(() => gate)
  return { resolve }
}

function findFileExplorerRow(node: unknown): ReactElementLike {
  let found: ReactElementLike | null = null
  visit(node, (candidate) => {
    if (candidate.type === FileExplorerRow) {
      found = candidate
    }
  })
  if (!found) {
    throw new Error('file explorer row not found')
  }
  return found
}

describe('file explorer directory refresh churn', () => {
  beforeEach(() => {
    readDirectoryMock.mockReset().mockResolvedValue(listing())
    useAppStore.setState(initialAppState, true)
    useAppStore.setState({
      settings: { activeRuntimeEnvironmentId: null } as AppState['settings']
    })
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(initialAppState, true)
  })

  it('rebuilds the visible row projection once per touched-directory refresh', async () => {
    const expanded = new Set([SRC_DIR])
    readDirectoryMock.mockResolvedValue(listing(entry('index.ts')))
    const { result, rebuilds } = renderTreeWithProjectionRebuildCounter(expanded)

    await act(async () => {
      await result.current.tree.loadDir(WORKTREE_PATH, -1, { force: true })
    })
    await act(async () => {
      await result.current.tree.loadDir(SRC_DIR, 0, { force: true })
    })
    const rebuildsBeforeRefresh = rebuilds()

    // One watcher-driven refresh of a directory that is already cached, with the read gated so the
    // loading state is committed and painted before the listing lands.
    const gatedRead = gateNextRead()
    let pendingRefresh!: Promise<void>
    await act(async () => {
      pendingRefresh = result.current.tree.refreshDir(SRC_DIR)
      await Promise.resolve()
    })
    expect(result.current.tree.loadingDirPaths.has(SRC_DIR)).toBe(true)
    // Why zero here: marking the dir loading used to commit a second dirCache identity carrying a
    // byte-identical row set, so every refresh paid for two full tree walks and flattens.
    expect(rebuilds()).toBe(rebuildsBeforeRefresh)

    await act(async () => {
      gatedRead.resolve(listing(entry('index.ts')))
      await pendingRefresh
    })
    expect(rebuilds() - rebuildsBeforeRefresh).toBe(1)
  })

  it('keeps the directory marked loading for the whole of a slow read', async () => {
    const expanded = new Set([SRC_DIR])
    const gatedRead = gateNextRead()
    const { result, rebuilds } = renderTreeWithProjectionRebuildCounter(expanded)

    let pendingLoad!: Promise<boolean>
    await act(async () => {
      pendingLoad = result.current.tree.loadDir(SRC_DIR, 0)
      await Promise.resolve()
    })
    expect(result.current.tree.loadingDirPaths.has(SRC_DIR)).toBe(true)
    const rebuildsWhileLoading = rebuilds()

    await act(async () => {
      gatedRead.resolve(listing(entry('index.ts')))
      await pendingLoad
    })
    expect(result.current.tree.loadingDirPaths.has(SRC_DIR)).toBe(false)
    expect(result.current.tree.dirCache[SRC_DIR].children).toHaveLength(1)
    // The spinner rendered without the projection being rebuilt for it.
    expect(rebuilds()).toBe(rebuildsWhileLoading + 1)
  })

  it('renders the folder spinner from the loading dir set', () => {
    const rowProps = {
      virtualizer: {
        getTotalSize: () => 26,
        getVirtualItems: () => [{ index: 0, key: 'src', start: 0 }],
        measureElement: vi.fn()
      } as never,
      inlineInputIndex: -1,
      rowProjection: createFileExplorerRowProjection([directoryNode]),
      inlineInput: null,
      handleInlineSubmit: vi.fn(),
      dismissInlineInput: vi.fn(),
      folderStatusByRelativePath: new Map(),
      statusByRelativePath: new Map(),
      ignoredByRelativePath: new Set<string>(),
      expanded: new Set([directoryNode.path]),
      selectedPaths: new Set<string>(),
      activeFileId: null,
      flashingPath: null,
      deleteShortcutLabel: 'Del',
      onClick: vi.fn(),
      onDoubleClick: vi.fn(),
      onViewFile: vi.fn(),
      onContextMenuSelect: vi.fn(),
      onCopyPaths: vi.fn(),
      onStartNew: vi.fn(),
      onStartRename: vi.fn(),
      onDuplicate: vi.fn(),
      onAddFolderAsProject: vi.fn(),
      canAddFolderAsProject: () => false,
      onOpenInTerminal: vi.fn(),
      onRequestDelete: vi.fn(),
      onCollapseFolderSubtree: vi.fn(),
      onFindInFolder: vi.fn(),
      onMoveDrop: vi.fn(),
      onDragTargetChange: vi.fn(),
      onDragSourceChange: vi.fn(),
      onDragExpandDir: vi.fn(),
      onNativeDragTargetChange: vi.fn(),
      onNativeDragExpandDir: vi.fn(),
      dropTargetDir: null,
      dragSourcePath: null,
      nativeDropTargetDir: null
    }

    const loading = FileExplorerVirtualRows({
      ...rowProps,
      loadingDirPaths: new Set([directoryNode.path])
    })
    const idle = FileExplorerVirtualRows({ ...rowProps, loadingDirPaths: new Set<string>() })

    expect(findFileExplorerRow(loading).props.isLoading).toBe(true)
    expect(findFileExplorerRow(idle).props.isLoading).toBe(false)
  })
})
