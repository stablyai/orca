import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { FileExplorerRow, type FileExplorerRowProps } from './FileExplorerRow'
import { FileExplorerVirtualRows } from './FileExplorerVirtualRows'
import { createFileExplorerRowProjection } from './file-explorer-row-projection'
import { directoryNode } from './file-explorer-tree-node-test-fixtures'
import { visit, type ReactElementLike } from './file-explorer-element-tree-test-harness'

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
