// @vitest-environment happy-dom
import type { ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { FileExplorerFilesTreePane } from './FileExplorerFilesTreePane'
import { FileExplorerTreeStatus } from './FileExplorerTreeStatus'
import { FileExplorerRow, type FileExplorerRowProps } from './FileExplorerRow'
import { FileExplorerVirtualRows } from './FileExplorerVirtualRows'
import { createFileExplorerRowProjection } from './file-explorer-row-projection'
import { directoryNode } from './file-explorer-tree-node-test-fixtures'
import { visit, type ReactElementLike } from './file-explorer-element-tree-test-harness'

type Props = ComponentProps<typeof FileExplorerFilesTreePane>
function emptyPane(
  error?: string,
  wslHostUnavailable: Props['wslHostUnavailable'] = null,
  refreshDir: (dirPath: string, options?: { wakeWslDistro?: boolean }) => Promise<void> = vi.fn()
) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This element-tree fixture supplies every field read by the empty pane; child components and event handlers are not executed.
  return FileExplorerFilesTreePane({
    worktreePath: '/repo',
    displayRootPath: '/repo/src',
    explorerView: 'files',
    visibleRowCount: 0,
    hasNameFilter: false,
    wslHostUnavailable,
    tree: {
      loadingDirPaths: new Set(),
      rootError: 'Full root unavailable',
      dirCache: { '/repo/src': { children: [], error } },
      refreshDir
    },
    selection: {},
    paneState: {
      inlineInputState: {},
      rowScrolling: {},
      handlers: {},
      nodeCommands: {},
      dragDrop: { rootDragHandlers: {} }
    }
  } as unknown as Props)
}

it.each([undefined, 'Permission denied', ''])(
  'uses the selected root error (%j), not a stale full-root error',
  (error) => {
    const elements: ReactElementLike[] = []
    visit(emptyPane(error), (element) => elements.push(element))
    const status = elements.find((element) => element.type === FileExplorerTreeStatus)
    expect(status?.props).toMatchObject({
      isLoading: false,
      error: error ?? null,
      isEmpty: error === undefined
    })
    expect(elements.some((element) => element.props?.role === 'status')).toBe(error !== undefined)
  }
)

it('renders an empty error message as a failed read rather than an empty directory', () => {
  const markup = renderToStaticMarkup(<FileExplorerTreeStatus isLoading={false} error="" isEmpty />)
  expect(markup).toContain('Could not load files for this workspace:')
  expect(markup).not.toContain('No files in this workspace')
})

it('describes the selected folder rather than claiming the whole workspace is empty', () => {
  const markup = renderToStaticMarkup(
    <FileExplorerTreeStatus isLoading={false} error={null} isEmpty scopedToFolder />
  )
  expect(markup).toContain('No files in this folder')
  expect(markup).not.toContain('No files in this workspace')
})

it('identifies a failed folder load without mislabeling workspace availability', () => {
  const markup = renderToStaticMarkup(
    <FileExplorerTreeStatus isLoading={false} error="Permission denied" isEmpty scopedToFolder />
  )
  expect(markup).toContain('Could not load this folder:')
  expect(markup).toContain('Permission denied')
})

it('swaps Retry for the turned-off state when the WSL host is turned off', () => {
  const elements: ReactElementLike[] = []
  visit(emptyPane('WSL hosts are turned off', 'turned-off'), (element) => elements.push(element))
  const status = elements.find((element) => element.type === FileExplorerTreeStatus)
  expect(status?.props).toMatchObject({ wslHostsTurnedOff: true })
  expect(elements.some((element) => element.props?.role === 'status')).toBe(false)
})

it('keeps the read error and Retry when the WSL host is not turned off', () => {
  const elements: ReactElementLike[] = []
  visit(emptyPane('Permission denied', 'server-files-missing'), (element) => elements.push(element))
  const status = elements.find((element) => element.type === FileExplorerTreeStatus)
  expect(status?.props).toMatchObject({ wslHostsTurnedOff: false })
  expect(elements.some((element) => element.props?.role === 'status')).toBe(true)
})

it('offers the WSL Turn on switch instead of a read error', () => {
  const markup = renderToStaticMarkup(
    <FileExplorerTreeStatus isLoading={false} error="unreachable" isEmpty wslHostsTurnedOff />
  )
  expect(markup).toContain('WSL hosts are turned off in Settings → Experimental')
  expect(markup).toContain('Turn on')
  expect(markup).not.toContain('Could not load files for this workspace')
})

const LOAD_ERROR = 'This folder has 80,000 entries, too many to list over a remote connection.'

function renderRow(overrides: Partial<FileExplorerRowProps>): string {
  const props: FileExplorerRowProps = {
    node: directoryNode,
    isExpanded: true,
    isLoading: false,
    isSelected: false,
    isFlashing: false,
    selectedPaths: new Set(),
    nodeStatus: null,
    statusColor: null,
    isIgnored: false,
    deleteShortcutLabel: 'Del',
    canOpenInOrcaBrowser: false,
    canCollapseFolderSubtree: true,
    targetDir: directoryNode.path,
    targetDepth: 1,
    selectionSize: 1,
    onClick: vi.fn(),
    onDoubleClick: vi.fn(),
    onViewFile: vi.fn(),
    onContextMenuSelect: vi.fn(),
    onCopyPaths: vi.fn(),
    onStartNew: vi.fn(),
    onStartRename: vi.fn(),
    onDuplicate: vi.fn(),
    onAddFolderAsProject: vi.fn(),
    canAddAsProject: false,
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
    ...overrides
  }
  return renderToStaticMarkup(<FileExplorerRow {...props} />)
}

describe('FileExplorerRow subfolder read failure', () => {
  it('shows the read error on an expanded folder instead of an empty listing', () => {
    expect(renderRow({ loadError: LOAD_ERROR })).toContain(LOAD_ERROR)
  })

  it('hides the error while collapsed or retrying', () => {
    expect(renderRow({ loadError: LOAD_ERROR, isExpanded: false })).not.toContain(LOAD_ERROR)
    expect(renderRow({ loadError: LOAD_ERROR, isLoading: true })).not.toContain(LOAD_ERROR)
  })

  it('passes the cached subfolder error to its row', () => {
    const virtualizerStub = {
      getTotalSize: () => 26,
      getVirtualItems: () => [{ index: 0, key: 'src', start: 0 }],
      measureElement: vi.fn()
    }
    const element = FileExplorerVirtualRows({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the rows read only getTotalSize/getVirtualItems/measureElement.
      virtualizer: virtualizerStub as never,
      inlineInputIndex: -1,
      rowProjection: createFileExplorerRowProjection([directoryNode]),
      inlineInput: null,
      handleInlineSubmit: vi.fn(),
      dismissInlineInput: vi.fn(),
      folderStatusByRelativePath: new Map(),
      statusByRelativePath: new Map(),
      ignoredByRelativePath: new Set(),
      expanded: new Set([directoryNode.path]),
      loadingDirPaths: new Set<string>(),
      selectedPaths: new Set(),
      activeFileId: null,
      flashingPath: null,
      deleteShortcutLabel: 'Del',
      dirCache: { [directoryNode.path]: { children: [], error: LOAD_ERROR } },
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
    })
    const rows: ReactElementLike[] = []
    visit(element, (entry) => {
      if (entry.type === FileExplorerRow) {
        rows.push(entry)
      }
    })
    expect(rows.map((row) => row.props.loadError)).toEqual([LOAD_ERROR])
  })
})

it('Retry is a user act, so it may start a stopped WSL distro', () => {
  const refreshDir = vi.fn(async () => {})
  const elements: ReactElementLike[] = []
  visit(emptyPane('WSL distro is not running', null, refreshDir), (element) =>
    elements.push(element)
  )
  const onClick = elements.find((element) => element.props?.size === 'xs')?.props.onClick
  expect(onClick).toBeTypeOf('function')
  if (typeof onClick === 'function') {
    onClick()
  }
  expect(refreshDir).toHaveBeenCalledWith('/repo/src', { wakeWslDistro: true })
})
