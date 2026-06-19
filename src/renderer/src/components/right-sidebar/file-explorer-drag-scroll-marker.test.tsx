// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileExplorerVirtualRows } from './FileExplorerVirtualRows'
import { useFileExplorerHandlers } from './useFileExplorerHandlers'
import { createFileExplorerRowProjection } from './file-explorer-row-projection'
import { FILE_EXPLORER_DRAGGABLE_SELECTOR } from './file-explorer-drag-scroll-marker'
import type { TreeNode } from './file-explorer-types'

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

function virtualRowsElement(nodes: TreeNode[]): React.JSX.Element {
  return FileExplorerVirtualRows({
    virtualizer: {
      getTotalSize: () => nodes.length * 26,
      getVirtualItems: () =>
        nodes.map((node, index) => ({ index, key: node.path, start: index * 26 })),
      measureElement: vi.fn()
    } as never,
    inlineInputIndex: -1,
    rowProjection: createFileExplorerRowProjection(nodes),
    inlineInput: null,
    handleInlineSubmit: vi.fn(),
    dismissInlineInput: vi.fn(),
    folderStatusByRelativePath: new Map(),
    statusByRelativePath: new Map(),
    ignoredByRelativePath: new Set(),
    expanded: new Set(),
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
    onAddFolderAsProject: vi.fn(),
    canAddFolderAsProject: () => false,
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
})

let capturedHandlers: ReturnType<typeof useFileExplorerHandlers> | null = null

function HandlersProbe({ scrollRef }: { scrollRef: React.RefObject<HTMLDivElement | null> }): null {
  capturedHandlers = useFileExplorerHandlers({
    activeWorktreeId: 'wt-1',
    openFile: vi.fn(),
    makePreviewFilePermanent: vi.fn(),
    toggleDir: vi.fn(),
    loadDir: vi.fn(),
    statPath: vi.fn(),
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
