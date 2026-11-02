// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { DirEntry } from '../../../../shared/filesystem-entry-types'

import { useFileExplorerTreeLoadEffects } from './use-file-explorer-tree-load-effects'
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
vi.mock('@/runtime/runtime-git-status-client', () => ({
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

    // Gate the refresh so loading commits before the new listing.
    const gatedRead = gateNextRead()
    let pendingRefresh!: Promise<void>
    await act(async () => {
      pendingRefresh = result.current.tree.refreshDir(SRC_DIR)
      await Promise.resolve()
    })
    expect(result.current.tree.loadingDirPaths.has(SRC_DIR)).toBe(true)
    // Loading must not replace identical dirCache rows and pay for a second full projection walk.
    expect(rebuilds()).toBe(rebuildsBeforeRefresh)

    await act(async () => {
      gatedRead.resolve(listing(entry('index.ts')))
      await pendingRefresh
    })
    expect(rebuilds() - rebuildsBeforeRefresh).toBe(1)
  })

  it('does not stack a second read on an expanded dir the loading set already owns', () => {
    const loadDir = vi.fn().mockResolvedValue(true)
    const params = {
      workspaceKey: null,
      visibleFilesWorktreePath: WORKTREE_PATH,
      expanded: new Set([SRC_DIR]),
      dirCache: {},
      loadingDirPaths: new Set([SRC_DIR]),
      rootError: null,
      isDirStale: () => false,
      loadDir,
      refreshTree: vi.fn().mockResolvedValue('refreshed'),
      resetAndLoad: vi.fn(),
      resetSelection: vi.fn(),
      setNameFilterQuery: vi.fn()
    }
    const hook = renderHook((props: typeof params) => useFileExplorerTreeLoadEffects(props), {
      initialProps: params
    })
    // Refresh waves premark owned dirs; expansion effects must not launch duplicate reads.
    expect(loadDir).not.toHaveBeenCalled()

    // Rerun after the wave’s read has landed and cleared its loading mark.
    hook.rerender({
      ...params,
      expanded: new Set([SRC_DIR]),
      loadingDirPaths: new Set<string>()
    })
    expect(loadDir).toHaveBeenCalledTimes(1)
    // Expanded since mount, not by the user now: the deferred read must not start WSL (E9).
    expect(loadDir).toHaveBeenCalledWith(SRC_DIR, 0, {})
  })
})
