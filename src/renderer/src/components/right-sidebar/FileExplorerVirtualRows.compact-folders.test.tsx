// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitFileStatus } from '../../../../shared/git-status-types'
import { FileExplorerVirtualRows } from './FileExplorerVirtualRows'
import { createCompactFileExplorerRowProjection } from './file-explorer-compact-folders'
import type { FileExplorerRowProjection } from './file-explorer-row-projection'
import type { TreeNode } from './file-explorer-types'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []

afterEach(() => {
  roots.splice(0).forEach((root) => {
    act(() => root.unmount())
  })
  document.body.replaceChildren()
})

function row(relativePath: string, isDirectory: boolean): TreeNode {
  return {
    name: relativePath.split('/').at(-1) ?? relativePath,
    path: `/repo/${relativePath}`,
    relativePath,
    isDirectory,
    depth: relativePath.split('/').length - 1
  }
}

async function renderRows(
  rowProjection: FileExplorerRowProjection,
  options: {
    onClick?: (node: TreeNode) => void
    folderStatusByRelativePath?: Map<string, GitFileStatus | null>
  } = {}
): Promise<HTMLButtonElement[]> {
  const count = rowProjection.getVisibleCount()
  const element = FileExplorerVirtualRows({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the rows read only getTotalSize/getVirtualItems/measureElement.
    virtualizer: {
      getTotalSize: () => count * 26,
      getVirtualItems: () =>
        Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 26 })),
      measureElement: vi.fn()
    } as never,
    inlineInputIndex: -1,
    rowProjection,
    inlineInput: null,
    handleInlineSubmit: vi.fn(),
    dismissInlineInput: vi.fn(),
    folderStatusByRelativePath: options.folderStatusByRelativePath ?? new Map(),
    statusByRelativePath: new Map(),
    ignoredByRelativePath: new Set(),
    expanded: new Set(['/repo/src', '/repo/src/main']),
    loadingDirPaths: new Set<string>(),
    selectedPaths: new Set(),
    activeFileId: null,
    flashingPath: null,
    deleteShortcutLabel: 'Del',
    onClick: (node) => options.onClick?.(node),
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
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(element)
  })
  return Array.from(container.querySelectorAll<HTMLButtonElement>('[data-file-explorer-row]'))
}

describe('FileExplorerVirtualRows with compact folders', () => {
  it('labels a compact row with each folded folder and indents its children one level', async () => {
    const projection = createCompactFileExplorerRowProjection(
      [
        row('src', true),
        row('src/main', true),
        row('src/main/java', true),
        row('src/main/java/App.java', false),
        row('build.gradle', false)
      ],
      () => false
    )

    const buttons = await renderRows(projection)

    expect(buttons.map((button) => button.textContent)).toEqual([
      'src/main/java',
      'App.java',
      'build.gradle'
    ])
    expect(buttons.map((button) => button.style.paddingLeft)).toEqual(['8px', '24px', '8px'])
  })

  it('hands the deepest folder of a compact row to clicks', async () => {
    const onClick = vi.fn()
    const projection = createCompactFileExplorerRowProjection(
      [row('src', true), row('src/main', true), row('src/main/App.java', false)],
      () => false
    )

    const [compactRow] = await renderRows(projection, { onClick })
    act(() => compactRow.click())

    expect(onClick).toHaveBeenCalledOnce()
    expect(onClick.mock.calls[0][0].path).toBe('/repo/src/main')
  })

  it('shows the outermost folder status, which also covers changes in the folded folders', async () => {
    const projection = createCompactFileExplorerRowProjection(
      [row('src', true), row('src/main', true), row('src/main/App.java', false)],
      () => false
    )

    const [compactRow] = await renderRows(projection, {
      // A changed dotfile directly in src, hidden from the tree, marks src but not src/main.
      folderStatusByRelativePath: new Map([['src', 'modified']])
    })

    expect(compactRow.textContent).toBe('src/mainM')
  })
})
