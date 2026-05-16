import { describe, expect, it, vi } from 'vitest'
import { EyeOff, ListCollapse, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { FileExplorerToolbar } from './FileExplorerToolbar'
import { FileExplorerRow, shouldShowCollapseFolderAction } from './FileExplorerRow'
import { FileExplorerVirtualRows } from './FileExplorerVirtualRows'
import type { TreeNode } from './file-explorer-types'

type ReactElementLike = {
  type: unknown
  props: Record<string, unknown>
}

function visit(node: unknown, cb: (node: ReactElementLike) => void): void {
  if (node == null || typeof node === 'string' || typeof node === 'number') {
    return
  }
  if (Array.isArray(node)) {
    node.forEach((entry) => visit(entry, cb))
    return
  }
  const element = node as ReactElementLike
  cb(element)
  if (element.props?.children) {
    visit(element.props.children, cb)
  }
}

function findRefreshButton(node: unknown): ReactElementLike {
  let found: ReactElementLike | null = null
  visit(node, (entry) => {
    if (entry.type === Button && entry.props['aria-label'] === 'Refresh Explorer') {
      found = entry
    }
  })
  if (!found) {
    throw new Error('refresh button not found')
  }
  return found
}

function findCollapseAllButton(node: unknown): ReactElementLike {
  let found: ReactElementLike | null = null
  visit(node, (entry) => {
    if (entry.type === Button && entry.props['aria-label'] === 'Collapse All') {
      found = entry
    }
  })
  if (!found) {
    throw new Error('collapse all button not found')
  }
  return found
}

function findGitIgnoredButton(node: unknown): ReactElementLike {
  let found: ReactElementLike | null = null
  visit(node, (entry) => {
    if (entry.type === Button && entry.props['aria-label'] === 'Hide Git Ignored Files') {
      found = entry
    }
  })
  if (!found) {
    throw new Error('git ignored button not found')
  }
  return found
}

function queryGitIgnoredButton(node: unknown): ReactElementLike | null {
  let found: ReactElementLike | null = null
  visit(node, (entry) => {
    if (entry.type === Button && entry.props['aria-label'] === 'Hide Git Ignored Files') {
      found = entry
    }
  })
  return found
}

function findFileExplorerRow(node: unknown): ReactElementLike {
  let found: ReactElementLike | null = null
  visit(node, (entry) => {
    if (entry.type === FileExplorerRow) {
      found = entry
    }
  })
  if (!found) {
    throw new Error('file explorer row not found')
  }
  return found
}

function findRepoNameLabel(node: unknown, repoName: string): ReactElementLike {
  let found: ReactElementLike | null = null
  visit(node, (entry) => {
    if (entry.type === 'span' && entry.props.title === repoName) {
      found = entry
    }
  })
  if (!found) {
    throw new Error('repo name label not found')
  }
  return found
}

function hasIcon(node: unknown, icon: unknown): boolean {
  let found = false
  visit(node, (entry) => {
    if (entry.type === icon) {
      found = true
    }
  })
  return found
}

function makeRefreshState(
  overrides: Partial<{
    isRefreshing: boolean
    showRefreshSpinner: boolean
    handleRefresh: () => void
  }> = {}
) {
  return {
    isRefreshing: false,
    showRefreshSpinner: false,
    handleRefresh: vi.fn(),
    ...overrides
  }
}

function makeToolbar(overrides: Partial<Parameters<typeof FileExplorerToolbar>[0]> = {}) {
  return FileExplorerToolbar({
    repoName: 'orca',
    refresh: makeRefreshState(),
    canCollapseAll: false,
    onCollapseAll: vi.fn(),
    showGitIgnoredFilesToggle: true,
    showGitIgnoredFiles: true,
    onToggleGitIgnoredFiles: vi.fn(),
    ...overrides
  })
}

describe('FileExplorerToolbar', () => {
  it('fires the refresh action from the icon button', () => {
    const onRefresh = vi.fn()
    const element = makeToolbar({ refresh: makeRefreshState({ handleRefresh: onRefresh }) })

    const button = findRefreshButton(element)
    ;(button.props.onClick as () => void)()

    expect(onRefresh).toHaveBeenCalledTimes(1)
    expect(button.props.disabled).toBe(false)
    expect(hasIcon(button, RefreshCw)).toBe(true)
    expect(hasIcon(button, Loader2)).toBe(false)
  })

  it('shows the repo name in a truncated label', () => {
    const repoName = 'really-long-repo-name-that-should-not-push-refresh-offscreen'
    const element = makeToolbar({ repoName })

    const label = findRepoNameLabel(element, repoName)

    expect(label.props.children).toBe(repoName)
    expect(label.props.className).toContain('truncate')
    expect(label.props.className).toContain('min-w-0')
  })

  it('disables the refresh button and shows a spinner while refreshing', () => {
    const element = makeToolbar({
      refresh: makeRefreshState({ isRefreshing: true, showRefreshSpinner: true })
    })

    const button = findRefreshButton(element)

    expect(button.props.disabled).toBe(true)
    expect(hasIcon(button, Loader2)).toBe(true)
    expect(hasIcon(button, RefreshCw)).toBe(false)
  })

  it('fires the collapse all action from the icon button', () => {
    const onCollapseAll = vi.fn()
    const element = makeToolbar({
      canCollapseAll: true,
      onCollapseAll
    })

    const button = findCollapseAllButton(element)
    ;(button.props.onClick as () => void)()

    expect(onCollapseAll).toHaveBeenCalledTimes(1)
    expect(button.props.disabled).toBe(false)
    expect(hasIcon(button, ListCollapse)).toBe(true)
  })

  it('disables collapse all when no directories are expanded', () => {
    const element = makeToolbar({ canCollapseAll: false })

    const button = findCollapseAllButton(element)

    expect(button.props.disabled).toBe(true)
    expect(hasIcon(button, ListCollapse)).toBe(true)
  })

  it('fires the git ignored visibility toggle from the icon button', () => {
    const onToggleGitIgnoredFiles = vi.fn()
    const element = makeToolbar({ onToggleGitIgnoredFiles })

    const button = findGitIgnoredButton(element)
    ;(button.props.onClick as () => void)()

    expect(onToggleGitIgnoredFiles).toHaveBeenCalledTimes(1)
    expect(hasIcon(button, EyeOff)).toBe(true)
  })

  it('hides the git ignored visibility toggle for non-git folders', () => {
    const element = makeToolbar({ showGitIgnoredFilesToggle: false })

    expect(queryGitIgnoredButton(element)).toBeNull()
  })
})

describe('FileExplorerRow collapse folder action', () => {
  const directoryNode: TreeNode = {
    name: 'src',
    path: '/repo/src',
    relativePath: 'src',
    isDirectory: true,
    depth: 0
  }

  it('only shows collapse folder for expanded directories', () => {
    expect(shouldShowCollapseFolderAction(directoryNode, true)).toBe(true)
    expect(shouldShowCollapseFolderAction(directoryNode, false)).toBe(false)
    expect(
      shouldShowCollapseFolderAction(
        {
          ...directoryNode,
          name: 'index.ts',
          path: '/repo/src/index.ts',
          relativePath: 'src/index.ts',
          isDirectory: false
        },
        true
      )
    ).toBe(false)
  })

  it('passes the row node to the collapse folder handler', () => {
    const onCollapseFolderSubtree = vi.fn()
    const element = FileExplorerVirtualRows({
      virtualizer: {
        getTotalSize: () => 26,
        getVirtualItems: () => [{ index: 0, key: 'src', start: 0 }],
        measureElement: vi.fn()
      } as never,
      inlineInputIndex: -1,
      flatRows: [directoryNode],
      inlineInput: null,
      handleInlineSubmit: vi.fn(),
      dismissInlineInput: vi.fn(),
      folderStatusByRelativePath: new Map(),
      statusByRelativePath: new Map(),
      ignoredByRelativePath: new Set(),
      expanded: new Set([directoryNode.path]),
      dirCache: {},
      selectedPaths: new Set(),
      activeFileId: null,
      flashingPath: null,
      deleteShortcutLabel: 'Del',
      onClick: vi.fn(),
      onDoubleClick: vi.fn(),
      onContextMenuSelect: vi.fn(),
      onCopyPaths: vi.fn(),
      onStartNew: vi.fn(),
      onStartRename: vi.fn(),
      onDuplicate: vi.fn(),
      onRequestDelete: vi.fn(),
      onCollapseFolderSubtree,
      onMoveDrop: vi.fn(),
      onDragTargetChange: vi.fn(),
      onDragSourceChange: vi.fn(),
      onDragExpandDir: vi.fn(),
      onNativeDragTargetChange: vi.fn(),
      onNativeDragExpandDir: vi.fn(),
      dropTargetDir: null,
      dragSourcePath: null,
      nativeDropTargetDir: null
    })

    const row = findFileExplorerRow(element)
    ;(row.props.onCollapseFolderSubtree as () => void)()

    expect(onCollapseFolderSubtree).toHaveBeenCalledWith(directoryNode)
  })
})
