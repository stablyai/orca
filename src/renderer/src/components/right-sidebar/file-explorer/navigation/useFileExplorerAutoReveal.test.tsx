// @vitest-environment happy-dom
import { act, cleanup, render, renderHook } from '@testing-library/react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { getCmdJQuickActions } from '@/components/cmd-j/quick-actions'
import { buildCmdJQuickActionContext } from '@/components/cmd-j/quick-action-context'
import { KEYBINDING_DEFINITIONS } from '../../../../../../shared/keybindings/definitions'
import { FILE_EXPLORER_FULL_ROOT } from '../../../../../../shared/file-listing/file-explorer-display-root'
import { createGlobalSettingsFixture } from '../../../../../../shared/settings/global-settings-test-fixture'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { FileExplorerRow } from '../panel/FileExplorerRow'
import { useFileExplorerSelection } from '../selection/useFileExplorerSelection'
import { createFileExplorerRowProjection } from '../tree/file-explorer-row-projection'
import type { DirCache, TreeNode } from '../tree/file-explorer-types'
import { revealActiveFileInExplorer } from './active-file-explorer-reveal'
import { useClearNameFilterForReveal } from './use-clear-name-filter-for-reveal'
import { useFileExplorerAutoReveal } from './useFileExplorerAutoReveal'
import { useFileExplorerReveal } from './useFileExplorerReveal'

const WORKTREE_ID = 'wt-1'
const ROOT = '/repo'
const EDIT_PATH = '/repo/src/alpha/deep.ts'
const PREVIEW_PATH = '/repo/docs/guide.md'
const DIFF_PATH = '/repo/src/changed.ts'
const OTHER_PATH = '/repo/src/beta/other.ts'
const SCOPED_ROOT = '/repo/packages/app'
const OUTSIDE_SCOPED_PATH = '/repo/packages/lib/util.ts'

const TEST_WORKTREE: Worktree = {
  id: WORKTREE_ID,
  repoId: 'repo-1',
  path: ROOT,
  head: 'abc123',
  branch: 'refs/heads/main',
  isBare: false,
  isMainWorktree: true,
  displayName: 'main',
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0
}

const OPEN_FILES: OpenFile[] = [
  {
    id: 'file-edit',
    filePath: EDIT_PATH,
    relativePath: 'src/alpha/deep.ts',
    worktreeId: WORKTREE_ID,
    language: 'typescript',
    isDirty: false,
    mode: 'edit'
  },
  {
    id: 'file-preview',
    filePath: PREVIEW_PATH,
    relativePath: 'docs/guide.md',
    worktreeId: WORKTREE_ID,
    language: 'markdown',
    isDirty: false,
    mode: 'markdown-preview'
  },
  {
    id: 'file-diff',
    filePath: DIFF_PATH,
    relativePath: 'src/changed.ts',
    worktreeId: WORKTREE_ID,
    language: 'typescript',
    isDirty: false,
    mode: 'diff',
    diffSource: 'unstaged'
  },
  {
    id: 'file-combined-diff',
    filePath: ROOT,
    relativePath: 'All Changes',
    worktreeId: WORKTREE_ID,
    language: 'plaintext',
    isDirty: false,
    mode: 'diff',
    diffSource: 'combined-all'
  },
  {
    id: 'file-git-graph',
    filePath: '',
    relativePath: 'Git Graph',
    worktreeId: WORKTREE_ID,
    language: 'plaintext',
    isDirty: false,
    mode: 'git-graph'
  },
  {
    id: 'file-other',
    filePath: OTHER_PATH,
    relativePath: 'src/beta/other.ts',
    worktreeId: WORKTREE_ID,
    language: 'typescript',
    isDirty: false,
    mode: 'edit'
  },
  {
    id: 'file-outside-scope',
    filePath: OUTSIDE_SCOPED_PATH,
    relativePath: 'packages/lib/util.ts',
    worktreeId: WORKTREE_ID,
    language: 'typescript',
    isDirty: false,
    mode: 'edit'
  }
]

const srcNode: TreeNode = {
  name: 'src',
  path: '/repo/src',
  relativePath: 'src',
  isDirectory: true,
  depth: 0
}
const alphaNode: TreeNode = {
  name: 'alpha',
  path: '/repo/src/alpha',
  relativePath: 'src/alpha',
  isDirectory: true,
  depth: 1
}
const editNode: TreeNode = {
  name: 'deep.ts',
  path: EDIT_PATH,
  relativePath: 'src/alpha/deep.ts',
  isDirectory: false,
  depth: 2
}
const previewNode: TreeNode = {
  name: 'guide.md',
  path: PREVIEW_PATH,
  relativePath: 'docs/guide.md',
  isDirectory: false,
  depth: 1
}
const diffNode: TreeNode = {
  name: 'changed.ts',
  path: DIFF_PATH,
  relativePath: 'src/changed.ts',
  isDirectory: false,
  depth: 1
}
const otherNode: TreeNode = {
  name: 'other.ts',
  path: OTHER_PATH,
  relativePath: 'src/beta/other.ts',
  isDirectory: false,
  depth: 2
}
const packagesNode: TreeNode = {
  name: 'packages',
  path: '/repo/packages',
  relativePath: 'packages',
  isDirectory: true,
  depth: 0
}
const libNode: TreeNode = {
  name: 'lib',
  path: '/repo/packages/lib',
  relativePath: 'packages/lib',
  isDirectory: true,
  depth: 1
}
const outsideScopedNode: TreeNode = {
  name: 'util.ts',
  path: OUTSIDE_SCOPED_PATH,
  relativePath: 'packages/lib/util.ts',
  isDirectory: false,
  depth: 2
}

const fullProjection = createFileExplorerRowProjection([
  srcNode,
  alphaNode,
  editNode,
  previewNode,
  diffNode,
  otherNode
])
const collapsedProjection = createFileExplorerRowProjection([srcNode])
const scopedProjection = createFileExplorerRowProjection([
  {
    name: 'index.ts',
    path: '/repo/packages/app/index.ts',
    relativePath: 'packages/app/index.ts',
    isDirectory: false,
    depth: 2
  }
])

type HarnessProps = {
  activeFileId: string | null
  worktreePath: string | null
  displayRootPath?: string | null
  rowProjection: ReturnType<typeof createFileExplorerRowProjection>
  dirCache?: Record<string, DirCache>
  initialNameFilter?: string
  onRevealOutsideRoot?: () => void
  openFiles?: OpenFile[]
}

function makeLoadedCache(childrenByDir: Record<string, TreeNode[]>): Record<string, DirCache> {
  const result: Record<string, DirCache> = {}
  for (const [dirPath, children] of Object.entries(childrenByDir)) {
    result[dirPath] = { children }
  }
  return result
}

function renderExplorerRevealHarness(initialProps: HarnessProps) {
  const scrollToIndex = vi.fn()
  const loadDir = vi.fn(async () => true)
  const hook = renderHook(
    (props: HarnessProps) => {
      const [nameFilterQuery, setNameFilterQuery] = useState(props.initialNameFilter ?? '')
      const [flashingPath, setFlashingPath] = useState<string | null>(null)
      const flashTimeoutRef = useRef<number | null>(null)
      const pendingExplorerReveal = useAppStore((s) => s.pendingExplorerReveal)
      const clearPendingExplorerReveal = useAppStore((s) => s.clearPendingExplorerReveal)
      const expanded = useAppStore((s) => s.expandedDirs[WORKTREE_ID]) ?? new Set<string>()
      const selection = useFileExplorerSelection(props.rowProjection, true, 'local')
      const virtualizer = useVirtualizer<HTMLDivElement, Element>({
        count: props.rowProjection.getVisibleCount(),
        getScrollElement: () => null,
        estimateSize: () => 26
      })
      virtualizer.scrollToIndex = scrollToIndex
      const hasNameFilterQuery = nameFilterQuery.trim().length > 0
      const displayRootPath = props.displayRootPath ?? props.worktreePath

      useClearNameFilterForReveal({
        activeWorktreeId: WORKTREE_ID,
        visibleFilesWorktreePath: props.worktreePath,
        hasNameFilter: props.worktreePath !== null && hasNameFilterQuery,
        setNameFilterQuery
      })

      useFileExplorerReveal({
        onRevealOutsideRoot: props.onRevealOutsideRoot,
        activeWorktreeId: WORKTREE_ID,
        worktreePath: props.worktreePath,
        displayRootPath,
        pendingExplorerReveal,
        clearPendingExplorerReveal,
        expanded,
        dirCache: props.dirCache ?? {},
        loadingDirPaths: new Set<string>(),
        rootCache: displayRootPath ? props.dirCache?.[displayRootPath] : undefined,
        rowProjection: props.rowProjection,
        loadDir,
        setSelectedPath: selection.setSingleSelectedPath,
        setFlashingPath,
        flashTimeoutRef,
        virtualizer
      })

      useFileExplorerAutoReveal({
        activeFileId: props.activeFileId,
        activeWorktreeId: WORKTREE_ID,
        worktreePath: props.worktreePath,
        displayRootPath,
        pendingExplorerReveal,
        openFiles: props.openFiles ?? OPEN_FILES,
        hasNameFilterQuery,
        rowProjection: props.rowProjection,
        selectedPath: selection.selectedPath,
        setSelectedPath: selection.setSingleSelectedPath,
        virtualizer
      })

      return {
        selectedPath: selection.selectedPath,
        selectedPaths: selection.selectedPaths,
        setSelectedPaths: selection.setSelectedPaths,
        setSingleSelectedPath: selection.setSingleSelectedPath,
        flashingPath,
        nameFilterQuery,
        setNameFilterQuery
      }
    },
    { initialProps }
  )
  return { ...hook, scrollToIndex, loadDir }
}

function seedStore(overrides: Partial<ReturnType<typeof useAppStore.getState>> = {}): void {
  useAppStore.setState({
    activeView: 'terminal',
    activeWorktreeId: WORKTREE_ID,
    activeFileId: null,
    openFiles: OPEN_FILES,
    worktreesByRepo: { 'repo-1': [TEST_WORKTREE] },
    expandedDirs: {},
    explorerDisplayRootByWorktree: {},
    pendingExplorerReveal: null,
    rightSidebarOpen: true,
    rightSidebarTab: 'explorer',
    rightSidebarExplorerView: 'files',
    settings: createGlobalSettingsFixture({ explorerRevealActiveFile: true }),
    ...overrides
  })
}

describe('FileExplorer active file reveal', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    seedStore()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    useAppStore.setState({
      activeFileId: null,
      openFiles: [],
      expandedDirs: {},
      explorerDisplayRootByWorktree: {},
      pendingExplorerReveal: null,
      settings: null
    })
  })

  it('selects single paths and scrolls for active edit, markdown-preview, and diff tabs, ignoring non-file tabs', () => {
    const { result, rerender, scrollToIndex } = renderExplorerRevealHarness({
      activeFileId: null,
      worktreePath: ROOT,
      rowProjection: fullProjection
    })

    // Seed a multi-selection to verify auto-reveal replaces it with a single selection.
    act(() => result.current.setSelectedPaths(new Set([srcNode.path, otherNode.path])))

    rerender({ activeFileId: 'file-edit', worktreePath: ROOT, rowProjection: fullProjection })
    act(() => vi.runAllTimers())
    expect(result.current.selectedPath).toBe(EDIT_PATH)
    expect([...result.current.selectedPaths]).toEqual([EDIT_PATH])
    expect(result.current.flashingPath).toBeNull()
    expect(scrollToIndex).toHaveBeenLastCalledWith(2, { align: 'auto' })

    rerender({ activeFileId: 'file-preview', worktreePath: ROOT, rowProjection: fullProjection })
    act(() => vi.runAllTimers())
    expect(result.current.selectedPath).toBe(PREVIEW_PATH)
    expect([...result.current.selectedPaths]).toEqual([PREVIEW_PATH])
    expect(scrollToIndex).toHaveBeenLastCalledWith(3, { align: 'auto' })

    rerender({ activeFileId: 'file-diff', worktreePath: ROOT, rowProjection: fullProjection })
    act(() => vi.runAllTimers())
    expect(result.current.selectedPath).toBe(DIFF_PATH)
    expect([...result.current.selectedPaths]).toEqual([DIFF_PATH])
    expect(scrollToIndex).toHaveBeenLastCalledWith(4, { align: 'auto' })

    const callsBeforeVirtual = scrollToIndex.mock.calls.length
    rerender({
      activeFileId: 'file-combined-diff',
      worktreePath: ROOT,
      rowProjection: fullProjection
    })
    rerender({ activeFileId: 'file-git-graph', worktreePath: ROOT, rowProjection: fullProjection })
    act(() => vi.runAllTimers())
    expect(result.current.selectedPath).toBe(DIFF_PATH)
    expect(scrollToIndex).toHaveBeenCalledTimes(callsBeforeVirtual)
  })

  it('skips auto-reveal when the setting is off, while the command palette action still reveals without flashing', async () => {
    seedStore({
      activeFileId: 'file-diff',
      rightSidebarOpen: false,
      rightSidebarTab: 'source-control',
      rightSidebarExplorerView: 'search',
      settings: createGlobalSettingsFixture({ explorerRevealActiveFile: false })
    })

    const dirCache = makeLoadedCache({
      [ROOT]: [srcNode, diffNode],
      '/repo/src': [diffNode]
    })
    const { result, rerender, scrollToIndex } = renderExplorerRevealHarness({
      activeFileId: null,
      worktreePath: ROOT,
      rowProjection: fullProjection,
      dirCache
    })

    act(() => result.current.setSingleSelectedPath(OTHER_PATH))
    rerender({
      activeFileId: 'file-diff',
      worktreePath: ROOT,
      rowProjection: fullProjection,
      dirCache
    })
    act(() => vi.runAllTimers())

    expect(result.current.selectedPath).toBe(OTHER_PATH)
    expect(useAppStore.getState().pendingExplorerReveal).toBeNull()
    expect(scrollToIndex).not.toHaveBeenCalled()

    // Keybinding definition is registered under File Explorer and unbound by default.
    const keybindingDef = KEYBINDING_DEFINITIONS.find(
      (def) => def.id === 'fileExplorer.revealActiveFile'
    )
    expect(keybindingDef).toMatchObject({
      id: 'fileExplorer.revealActiveFile',
      title: 'Reveal Active File in Explorer',
      group: 'File Explorer',
      defaultBindings: { darwin: [], linux: [], win32: [] }
    })

    // Command palette action reveals even when explorerRevealActiveFile is off.
    const action = getCmdJQuickActions().find(
      (entry) => entry.id === 'fileExplorer.revealActiveFile'
    )
    expect(action?.title).toBe('Reveal Active File in Explorer')
    const ctx = buildCmdJQuickActionContext({
      state: useAppStore.getState(),
      activeGroupSnapshot: null,
      openNewBrowserTab: async () => {},
      openBrowserUrl: async () => {},
      openNewMarkdownFile: async () => {},
      openNewTerminalTab: async () => {},
      openCreateWorkspace: () => {},
      deleteActiveWorkspace: () => {},
      openAddQuickCommand: () => {}
    })
    expect(action?.isAvailable(ctx)).toEqual({ available: true })

    await act(async () => {
      const outcome = await action!.run(ctx)
      expect(outcome).toEqual({ status: 'ok' })
    })

    // Command forces Explorer -> Files and queues a non-flashing reveal.
    expect(useAppStore.getState().rightSidebarOpen).toBe(true)
    expect(useAppStore.getState().rightSidebarTab).toBe('explorer')
    expect(useAppStore.getState().rightSidebarExplorerView).toBe('files')

    act(() => vi.runAllTimers())
    expect(result.current.selectedPath).toBe(DIFF_PATH)
    expect(result.current.flashingPath).toBeNull()
    expect(scrollToIndex).toHaveBeenCalledWith(4, { align: 'center' })
  })

  it('expands collapsed ancestors before selecting and scrolling to the active file', async () => {
    const dirCache = makeLoadedCache({
      [ROOT]: [srcNode],
      '/repo/src': [alphaNode],
      '/repo/src/alpha': [editNode]
    })

    const { result, rerender, scrollToIndex, loadDir } = renderExplorerRevealHarness({
      activeFileId: null,
      worktreePath: ROOT,
      rowProjection: collapsedProjection,
      dirCache
    })

    rerender({
      activeFileId: 'file-edit',
      worktreePath: ROOT,
      rowProjection: collapsedProjection,
      dirCache
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    const expanded = useAppStore.getState().expandedDirs[WORKTREE_ID]
    expect(expanded?.has('/repo/src')).toBe(true)
    expect(expanded?.has('/repo/src/alpha')).toBe(true)
    expect(loadDir).toHaveBeenCalledWith('/repo', -1)
    expect(loadDir).toHaveBeenCalledWith('/repo/src', 0)
    expect(loadDir).toHaveBeenCalledWith('/repo/src/alpha', 1)

    // Once the expanded projection commits, the reveal resolves without flashing.
    rerender({
      activeFileId: 'file-edit',
      worktreePath: ROOT,
      rowProjection: fullProjection,
      dirCache
    })
    act(() => vi.runAllTimers())

    expect(result.current.selectedPath).toBe(EDIT_PATH)
    expect(result.current.flashingPath).toBeNull()
    expect(useAppStore.getState().pendingExplorerReveal).toBeNull()
    expect(scrollToIndex).toHaveBeenCalledWith(2, { align: 'center' })
  })

  it('moves the display root up to the repository root when revealing a file outside the scoped root', () => {
    const dirCache = makeLoadedCache({
      [ROOT]: [packagesNode],
      '/repo/packages': [libNode],
      '/repo/packages/lib': [outsideScopedNode]
    })
    const fullRootProjection = createFileExplorerRowProjection([
      packagesNode,
      libNode,
      outsideScopedNode
    ])

    const { result, rerender, scrollToIndex } = renderExplorerRevealHarness({
      activeFileId: null,
      worktreePath: ROOT,
      displayRootPath: SCOPED_ROOT,
      rowProjection: scopedProjection,
      dirCache
    })

    rerender({
      activeFileId: 'file-outside-scope',
      worktreePath: ROOT,
      displayRootPath: SCOPED_ROOT,
      rowProjection: scopedProjection,
      dirCache
    })

    expect(useAppStore.getState().explorerDisplayRootByWorktree[WORKTREE_ID]).toBe(
      FILE_EXPLORER_FULL_ROOT
    )

    // Re-render at the repository root after the store resets the display root.
    rerender({
      activeFileId: 'file-outside-scope',
      worktreePath: ROOT,
      displayRootPath: ROOT,
      rowProjection: fullRootProjection,
      dirCache
    })
    act(() => vi.runAllTimers())

    expect(result.current.selectedPath).toBe(OUTSIDE_SCOPED_PATH)
    expect(result.current.flashingPath).toBeNull()
    expect(scrollToIndex).toHaveBeenCalledWith(2, { align: 'center' })
  })

  it('skips auto-reveal while a name filter is active and leaves the filter in place', () => {
    const { result, rerender, scrollToIndex } = renderExplorerRevealHarness({
      activeFileId: null,
      worktreePath: ROOT,
      rowProjection: fullProjection,
      initialNameFilter: 'alpha'
    })

    rerender({
      activeFileId: 'file-diff',
      worktreePath: ROOT,
      rowProjection: fullProjection
    })
    act(() => vi.runAllTimers())

    expect(result.current.nameFilterQuery).toBe('alpha')
    expect(result.current.selectedPath).toBeNull()
    expect(useAppStore.getState().pendingExplorerReveal).toBeNull()
    expect(scrollToIndex).not.toHaveBeenCalled()

    // Clearing the filter applies the remembered active file.
    act(() => result.current.setNameFilterQuery(''))
    act(() => vi.runAllTimers())
    expect(result.current.selectedPath).toBe(DIFF_PATH)
  })

  it('keeps a manual tree selection while the same activeFileId remains active', () => {
    const { result, rerender, scrollToIndex } = renderExplorerRevealHarness({
      activeFileId: 'file-edit',
      worktreePath: ROOT,
      rowProjection: fullProjection
    })
    act(() => vi.runAllTimers())
    expect(result.current.selectedPath).toBe(EDIT_PATH)

    act(() => result.current.setSingleSelectedPath(OTHER_PATH))
    scrollToIndex.mockClear()

    // Re-rendering with updated openFiles metadata or a hidden/shown cycle must not steal selection.
    const dirtyOpenFiles = OPEN_FILES.map((file) =>
      file.id === 'file-edit' ? { ...file, isDirty: true } : file
    )
    rerender({
      activeFileId: 'file-edit',
      worktreePath: ROOT,
      rowProjection: fullProjection,
      openFiles: dirtyOpenFiles
    })
    rerender({
      activeFileId: 'file-edit',
      worktreePath: null,
      rowProjection: fullProjection,
      openFiles: dirtyOpenFiles
    })
    rerender({
      activeFileId: 'file-edit',
      worktreePath: ROOT,
      rowProjection: fullProjection,
      openFiles: dirtyOpenFiles
    })
    act(() => vi.runAllTimers())

    expect(result.current.selectedPath).toBe(OTHER_PATH)
    expect(scrollToIndex).not.toHaveBeenCalled()
  })

  it('does not open the sidebar or switch sidebar tabs during auto-reveal, and applies when Files is shown again', () => {
    seedStore({
      rightSidebarOpen: false,
      rightSidebarTab: 'source-control',
      rightSidebarExplorerView: 'search'
    })

    const { result, rerender, scrollToIndex } = renderExplorerRevealHarness({
      activeFileId: null,
      worktreePath: null,
      rowProjection: fullProjection
    })

    rerender({
      activeFileId: 'file-diff',
      worktreePath: null,
      rowProjection: fullProjection
    })
    act(() => vi.runAllTimers())

    expect(useAppStore.getState().rightSidebarOpen).toBe(false)
    expect(useAppStore.getState().rightSidebarTab).toBe('source-control')
    expect(useAppStore.getState().rightSidebarExplorerView).toBe('search')
    expect(useAppStore.getState().pendingExplorerReveal).toBeNull()
    expect(result.current.selectedPath).toBeNull()

    // Showing the Files tree later applies the remembered active file.
    rerender({
      activeFileId: 'file-diff',
      worktreePath: ROOT,
      rowProjection: fullProjection
    })
    act(() => vi.runAllTimers())

    expect(result.current.selectedPath).toBe(DIFF_PATH)
    expect(scrollToIndex).toHaveBeenCalledWith(4, { align: 'auto' })
  })

  it('paints a visible background class on the selected FileExplorerRow without amber flash', () => {
    const noop = () => {}
    const baseProps = {
      node: editNode,
      isExpanded: false,
      isLoading: false,
      isFlashing: false,
      selectedPaths: new Set([editNode.path]),
      nodeStatus: null,
      statusColor: null,
      isIgnored: false,
      deleteShortcutLabel: 'Del',
      canOpenInOrcaBrowser: false,
      canCollapseFolderSubtree: true,
      targetDir: '/repo/src/alpha',
      targetDepth: 2,
      selectionSize: 1,
      onClick: noop,
      onDoubleClick: noop,
      onViewFile: noop,
      onContextMenuSelect: noop,
      onCopyPaths: noop,
      onStartNew: noop,
      onStartRename: noop,
      onDuplicate: noop,
      onAddFolderAsProject: noop,
      canAddAsProject: false,
      onOpenInTerminal: noop,
      onRequestDelete: noop,
      onCollapseFolderSubtree: noop,
      onFindInFolder: noop,
      onMoveDrop: noop,
      onDragTargetChange: noop,
      onDragSourceChange: noop,
      onDragExpandDir: noop,
      onNativeDragTargetChange: noop,
      onNativeDragExpandDir: noop
    }

    const { container, rerender } = render(<FileExplorerRow {...baseProps} isSelected />)
    const selectedButton = container.querySelector<HTMLButtonElement>('[data-file-explorer-row]')
    expect(selectedButton?.getAttribute('data-selected')).toBe('true')
    const selectedTokens = (selectedButton?.className ?? '').split(/\s+/)
    expect(selectedTokens).toContain('bg-accent')
    expect(selectedTokens).toContain('text-accent-foreground')
    expect(selectedTokens).not.toContain('hover:bg-accent')
    expect(selectedTokens).not.toContain('bg-amber-400/20')

    rerender(
      <FileExplorerRow {...baseProps} isSelected={false} selectedPaths={new Set<string>()} />
    )
    const unselectedButton = container.querySelector<HTMLButtonElement>('[data-file-explorer-row]')
    const unselectedTokens = (unselectedButton?.className ?? '').split(/\s+/)
    expect(unselectedTokens).not.toContain('bg-accent')
    expect(unselectedTokens).toContain('hover:bg-accent')
  })

  it('ignores non-file active tabs in revealActiveFileInExplorer', () => {
    seedStore({ activeFileId: 'file-git-graph' })
    expect(revealActiveFileInExplorer(useAppStore.getState())).toBe(false)
    expect(useAppStore.getState().pendingExplorerReveal).toBeNull()
  })
})
