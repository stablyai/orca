// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileExplorerVirtualRows } from './FileExplorerVirtualRows'
import { useFileExplorerHandlers } from './useFileExplorerHandlers'
import { createFileExplorerRowProjection } from './file-explorer-row-projection'
import { createVisibleFileExplorerRowProjection } from './useFileExplorerVisibleRowProjection'
import { FILE_EXPLORER_DRAGGABLE_SELECTOR } from './file-explorer-drag-scroll-marker'
import type { DirCache, TreeNode } from './file-explorer-types'
import { readWorkspaceFileDragSource } from '@/lib/workspace-file-drag'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []

afterEach(() => {
  roots.splice(0).forEach((root) => {
    act(() => root.unmount())
  })
  document.body.replaceChildren()
  capturedHandlers = null
})

async function renderToBody(element: React.JSX.Element): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(element)
  })
  return container
}

const fileNode: TreeNode = {
  name: 'index.ts',
  path: '/repo/src/index.ts',
  relativePath: 'src/index.ts',
  isDirectory: false,
  depth: 0
}
const directoryNode: TreeNode = {
  name: 'src',
  path: '/repo/src',
  relativePath: 'src',
  isDirectory: true,
  depth: 0
}

function virtualRowsElement(
  nodes: TreeNode[],
  options: {
    dirCache?: Record<string, DirCache>
    selectedPaths?: Set<string>
    sourceWorkspaceId?: string
    rowProjection?: ReturnType<typeof createFileExplorerRowProjection>
  } = {}
): React.JSX.Element {
  return FileExplorerVirtualRows({
    virtualizer: {
      getTotalSize: () => nodes.length * 26,
      getVirtualItems: () =>
        nodes.map((node, index) => ({ index, key: node.path, start: index * 26 })),
      measureElement: vi.fn()
    } as never,
    inlineInputIndex: -1,
    rowProjection: options.rowProjection ?? createFileExplorerRowProjection(nodes),
    inlineInput: null,
    handleInlineSubmit: vi.fn(),
    dismissInlineInput: vi.fn(),
    folderStatusByRelativePath: new Map(),
    statusByRelativePath: new Map(),
    ignoredByRelativePath: new Set(),
    expanded: new Set(),
    loadingDirPaths: new Set<string>(),
    selectedPaths: options.selectedPaths ?? new Set(),
    activeFileId: null,
    flashingPath: null,
    deleteShortcutLabel: 'Del',
    sourceWorkspaceId: options.sourceWorkspaceId,
    dirCache: options.dirCache,
    onClick: vi.fn(),
    onDoubleClick: vi.fn(),
    onContextMenuSelect: vi.fn(),
    onCopyPaths: vi.fn(),
    onViewFile: vi.fn(),
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
  })
}

describe('file explorer draggable rows carry the wheel-scroll marker', () => {
  // Why: every draggable row must be tagged so the wheel-capture handler can
  // rescue trackpad scroll that Chromium otherwise swallows over draggable nodes.
  it('marks file and directory rows so the wheel handler can target them', async () => {
    const container = await renderToBody(virtualRowsElement([fileNode, directoryNode]))

    const draggableButtons = container.querySelectorAll('[draggable="true"]')
    expect(draggableButtons.length).toBe(2)
    draggableButtons.forEach((button) => {
      expect(button.matches(FILE_EXPLORER_DRAGGABLE_SELECTOR)).toBe(true)
    })
  })

  it('stamps a row with the workspace and host that produced its cached node', async () => {
    const cachedNode: TreeNode = {
      ...fileNode,
      operationOwner: {
        kind: 'runtime',
        environmentId: 'old-env',
        executionHostId: 'runtime:old-env'
      }
    }
    const container = await renderToBody(
      virtualRowsElement([cachedNode], { sourceWorkspaceId: 'old-workspace' })
    )
    const transfer = new DataTransfer()
    const event = new Event('dragstart', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: transfer })

    container.querySelector('[data-file-explorer-row]')?.dispatchEvent(event)

    expect(readWorkspaceFileDragSource(transfer)).toEqual({
      executionHostId: 'runtime:old-env',
      workspaceId: 'old-workspace'
    })
  })

  it('omits ownership when selected cached rows came from different hosts', async () => {
    const localNode: TreeNode = { ...fileNode, operationOwner: { kind: 'local' } }
    const sshNode: TreeNode = {
      ...directoryNode,
      operationOwner: { kind: 'ssh', connectionId: 'remote-1' }
    }
    const container = await renderToBody(
      virtualRowsElement([localNode, sshNode], {
        selectedPaths: new Set([localNode.path, sshNode.path]),
        sourceWorkspaceId: 'workspace-1'
      })
    )
    const transfer = new DataTransfer()
    const event = new Event('dragstart', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: transfer })

    container.querySelector('[data-file-explorer-row]')?.dispatchEvent(event)

    expect(readWorkspaceFileDragSource(transfer)).toBeNull()
  })

  // A selection outlives the rows that showed it: nothing prunes selectedPaths
  // when a directory collapses, and the drag still carries every selected path.
  // Resolving only against visible rows refused a drag whose owner the cache
  // knows perfectly well.
  it('stamps a selection that reaches under a collapsed directory', async () => {
    const owner = { kind: 'local' } as const
    const collapsedChild: TreeNode = {
      name: 'a.ts',
      path: '/repo/src/a.ts',
      relativePath: 'src/a.ts',
      isDirectory: false,
      depth: 1,
      operationOwner: owner
    }
    const readme: TreeNode = {
      name: 'README.md',
      path: '/repo/README.md',
      relativePath: 'README.md',
      isDirectory: false,
      depth: 0,
      operationOwner: owner
    }
    const dirCache = {
      '/repo': {
        children: [{ ...directoryNode, operationOwner: owner }, readme],
        operationOwner: owner
      },
      '/repo/src': { children: [collapsedChild], operationOwner: owner }
    }
    // `expanded` is empty, so /repo/src is collapsed and a.ts is not a row.
    const projection = createVisibleFileExplorerRowProjection(
      { dirCache, expanded: new Set<string>(), worktreePath: '/repo' },
      {
        ignoredSet: new Set<string>(),
        nameFilter: null,
        showDotfiles: true,
        showGitIgnoredFiles: true
      }
    )
    expect(projection.getRowByPath(collapsedChild.path)).toBeNull()

    const container = await renderToBody(
      virtualRowsElement([directoryNode, readme], {
        dirCache,
        rowProjection: projection,
        selectedPaths: new Set([readme.path, collapsedChild.path]),
        sourceWorkspaceId: 'workspace-1'
      })
    )
    const transfer = new DataTransfer()
    const event = new Event('dragstart', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: transfer })

    container.querySelectorAll('[data-file-explorer-row]')[1]?.dispatchEvent(event)

    expect(readWorkspaceFileDragSource(transfer)).toEqual({
      executionHostId: 'local',
      workspaceId: 'workspace-1'
    })
  })

  // The virtualizer re-renders on every scroll frame; a per-render owner scan
  // over the whole selection would be paid on each of them.
  it('resolves drag ownership at dragstart, not while rendering rows', async () => {
    const localNode: TreeNode = { ...fileNode, operationOwner: { kind: 'local' } }
    const otherNode: TreeNode = { ...directoryNode, operationOwner: { kind: 'local' } }
    const projection = createFileExplorerRowProjection([localNode, otherNode])
    const getRowByPath = vi.fn(projection.getRowByPath)
    const container = await renderToBody(
      virtualRowsElement([localNode, otherNode], {
        rowProjection: { ...projection, getRowByPath },
        selectedPaths: new Set([localNode.path, otherNode.path]),
        sourceWorkspaceId: 'workspace-1'
      })
    )

    expect(getRowByPath).not.toHaveBeenCalled()

    const transfer = new DataTransfer()
    const event = new Event('dragstart', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: transfer })
    container.querySelector('[data-file-explorer-row]')?.dispatchEvent(event)

    expect(getRowByPath.mock.calls.map(([path]) => path)).toEqual([localNode.path, otherNode.path])
    expect(readWorkspaceFileDragSource(transfer)).toEqual({
      executionHostId: 'local',
      workspaceId: 'workspace-1'
    })
  })
})

let capturedHandlers: ReturnType<typeof useFileExplorerHandlers> | null = null

function HandlersProbe({ scrollRef }: { scrollRef: React.RefObject<HTMLDivElement | null> }): null {
  capturedHandlers = useFileExplorerHandlers({
    activeWorktreeId: 'wt-1',
    runtimeEnvironmentId: null,
    openFile: vi.fn(),
    makePreviewFilePermanent: vi.fn(),
    toggleDir: vi.fn(),
    loadDir: vi.fn(),
    statPath: vi.fn(),
    grantExternalPath: vi.fn(),
    markPathAsDirectory: vi.fn(),
    setSelectedPath: vi.fn(),
    scrollRef
  })
  return null
}

function makeViewport(
  scrollHeight = 1000,
  clientHeight = 200
): { viewport: HTMLDivElement; getScrollTop: () => number } {
  const viewport = document.createElement('div')
  let scrollTop = 0
  Object.defineProperty(viewport, 'scrollHeight', { value: scrollHeight, configurable: true })
  Object.defineProperty(viewport, 'clientHeight', { value: clientHeight, configurable: true })
  Object.defineProperty(viewport, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value
    }
  })
  document.body.appendChild(viewport)
  return { viewport, getScrollTop: () => scrollTop }
}

describe('handleWheelCapture rescues scroll over draggable rows', () => {
  it('scrolls the viewport when the wheel lands inside a marked row', async () => {
    const { viewport, getScrollTop } = makeViewport()
    const scrollRef = { current: viewport }
    await renderToBody(<HandlersProbe scrollRef={scrollRef} />)

    const row = document.createElement('button')
    row.setAttribute('data-explorer-draggable', 'true')
    const label = document.createElement('span')
    row.appendChild(label)
    viewport.appendChild(row)

    const preventDefault = vi.fn()
    capturedHandlers!.handleWheelCapture({
      target: label,
      deltaX: 0,
      deltaY: 48,
      preventDefault
    } as never)

    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(getScrollTop()).toBe(48)
  })

  it('leaves native scroll alone when the wheel is not over a draggable row', async () => {
    const { viewport, getScrollTop } = makeViewport()
    const scrollRef = { current: viewport }
    await renderToBody(<HandlersProbe scrollRef={scrollRef} />)

    const plain = document.createElement('div')
    viewport.appendChild(plain)

    const preventDefault = vi.fn()
    capturedHandlers!.handleWheelCapture({
      target: plain,
      deltaX: 0,
      deltaY: 48,
      preventDefault
    } as never)

    expect(preventDefault).not.toHaveBeenCalled()
    expect(getScrollTop()).toBe(0)
  })

  it('ignores horizontal-dominant wheel gestures over a marked row', async () => {
    const { viewport, getScrollTop } = makeViewport()
    const scrollRef = { current: viewport }
    await renderToBody(<HandlersProbe scrollRef={scrollRef} />)

    const row = document.createElement('button')
    row.setAttribute('data-explorer-draggable', 'true')
    viewport.appendChild(row)

    const preventDefault = vi.fn()
    capturedHandlers!.handleWheelCapture({
      target: row,
      deltaX: 120,
      deltaY: 10,
      preventDefault
    } as never)

    expect(preventDefault).not.toHaveBeenCalled()
    expect(getScrollTop()).toBe(0)
  })

  it('does not hijack the wheel when the viewport does not overflow', async () => {
    const { viewport, getScrollTop } = makeViewport(150, 400)
    const scrollRef = { current: viewport }
    await renderToBody(<HandlersProbe scrollRef={scrollRef} />)

    const row = document.createElement('button')
    row.setAttribute('data-explorer-draggable', 'true')
    viewport.appendChild(row)

    const preventDefault = vi.fn()
    capturedHandlers!.handleWheelCapture({
      target: row,
      deltaX: 0,
      deltaY: 48,
      preventDefault
    } as never)

    expect(preventDefault).not.toHaveBeenCalled()
    expect(getScrollTop()).toBe(0)
  })
})
