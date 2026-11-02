// @vitest-environment happy-dom
import { useRef, type ComponentProps } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useFileExplorerDragDrop } from './useFileExplorerDragDrop'
import { useFileExplorerImport } from './useFileExplorerImport'
import { FileExplorerFilesTreePane } from './FileExplorerFilesTreePane'

const mocks = vi.hoisted(() => ({ startDragEdgeScroll: vi.fn(), stopDragEdgeScroll: vi.fn() }))
vi.mock('./useFileExplorerDragEdgeScroll', () => ({
  useFileExplorerDragEdgeScroll: () => ({
    startDragEdgeScroll: mocks.startDragEdgeScroll,
    stopDragEdgeScroll: mocks.stopDragEdgeScroll
  })
}))

const refreshDir = vi.fn().mockResolvedValue(undefined)

function Explorer(): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const dragDrop = useFileExplorerDragDrop({
    worktreePath: '/repo',
    activeWorktreeId: 'wt-1',
    expanded: new Set(),
    toggleDir: vi.fn(),
    refreshDir,
    scrollRef,
    getOperationOwnerForPath: () => undefined
  })
  const ownerRef = useFileExplorerImport({
    worktreeId: 'wt-1',
    worktreePath: '/repo',
    refreshDir,
    clearNativeDragState: dragDrop.clearNativeDragState,
    setSelectedPath: vi.fn()
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The empty pane reads these fields only; row handlers and virtual rows are not rendered.
  const props = {
    worktreePath: '/repo',
    displayRootPath: '/repo',
    explorerView: 'files',
    visibleRowCount: 0,
    hasNameFilter: false,
    tree: { loadingDirPaths: new Set(), rootError: null, dirCache: { '/repo': { children: [] } } },
    selection: {},
    paneState: {
      scrollRef,
      fileDropOwnerRef: ownerRef,
      inlineInputState: {},
      rowScrolling: {},
      handlers: {},
      nodeCommands: {},
      dragDrop
    }
  } as unknown as ComponentProps<typeof FileExplorerFilesTreePane>
  return <FileExplorerFilesTreePane {...props} />
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('file explorer edge auto-scroll under the OS-drop owner', () => {
  it('still auto-scrolls while an OS file drag hovers the tree', () => {
    const view = render(<Explorer />)
    const ownerRoot = view.container.querySelector('[data-os-file-drop-owner]')
    view.rerender(<Explorer />)
    expect(view.container.querySelector('[data-os-file-drop-owner]')).toBe(ownerRoot)
    const transfer = { types: ['Files'], files: [], dropEffect: 'move' }
    const event = new Event('dragover', { bubbles: true, cancelable: true, composed: true })
    Object.defineProperty(event, 'dataTransfer', { value: transfer })
    Object.defineProperty(event, 'clientY', { value: 4 })
    act(() => {
      view.getByText('No files in this workspace').dispatchEvent(event)
    })
    // The owner claimed the drag and stopped it, yet the capture handler saw it first.
    expect(event.defaultPrevented).toBe(true)
    expect(transfer.dropEffect).toBe('copy')
    expect(mocks.startDragEdgeScroll).toHaveBeenCalledWith(4)
  })
})
