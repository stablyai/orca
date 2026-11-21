// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { TreeNode } from '../tree/file-explorer-types'
import { FileExplorerRow } from './FileExplorerRow'
import { splitFileExplorerRowName } from './file-explorer-row-name-split'

afterEach(cleanup)

const noop = (): void => {}
const emptySet = new Set<string>()

function renderRow(name: string, overrides?: Partial<TreeNode>): HTMLElement {
  const node: TreeNode = {
    name,
    path: `/workspace/${name}`,
    relativePath: name,
    isDirectory: false,
    depth: 1,
    ...overrides
  }
  render(
    <FileExplorerRow
      node={node}
      isExpanded={false}
      isLoading={false}
      isSelected={false}
      isFlashing={false}
      selectedPaths={emptySet}
      nodeStatus={null}
      statusColor={null}
      isIgnored={false}
      deleteShortcutLabel="⌘⌫"
      canOpenInOrcaBrowser={false}
      canCollapseFolderSubtree={false}
      targetDir="/workspace"
      targetDepth={1}
      selectionSize={1}
      onClick={noop}
      onDoubleClick={noop}
      onViewFile={noop}
      onContextMenuSelect={noop}
      onCopyPaths={noop}
      onStartNew={noop}
      onStartRename={noop}
      onDuplicate={noop}
      onAddFolderAsProject={noop}
      canAddAsProject={false}
      onOpenInTerminal={noop}
      onRequestDelete={noop}
      onCollapseFolderSubtree={noop}
      onFindInFolder={noop}
      onMoveDrop={noop}
      onDragTargetChange={noop}
      onDragSourceChange={noop}
      onDragExpandDir={noop}
      onNativeDragTargetChange={noop}
      onNativeDragExpandDir={noop}
    />
  )
  return screen.getByRole('button', { name })
}

describe('FileExplorerRow', () => {
  it('names a split row once and keeps the full name on hover', () => {
    const fileName = 'use-combined-dialog-resize.test.tsx'
    renderRow(fileName)

    expect(screen.getByRole('button', { name: fileName })).toBeTruthy()
    const visibleParts = screen.getByTitle(fileName).querySelectorAll('[aria-hidden]')
    expect(Array.from(visibleParts, (part) => part.textContent)).toEqual([
      'use-combined-dialog',
      '-resize.test.tsx'
    ])
  })
})

describe('splitFileExplorerRowName', () => {
  it.each([
    [
      'use-combined-diff-file-tree-resize.test.tsx',
      'use-combined-diff-file-tree',
      '-resize.test.tsx'
    ],
    ['use-combined-diff-file-tree-resize.ts', 'use-combined-diff-file', '-tree-resize.ts'],
    ['combined-diff-file-tree-rows.tsx', 'combined-diff-file', '-tree-rows.tsx'],
    ['FileExplorerVirtualRows.tsx', 'FileExplorer', 'VirtualRows.tsx'],
    ['my long file name.txt', 'my long file', ' name.txt'],
    ['use-x.test.tsx', 'use-x.', 'test.tsx'],
    [
      '这是一个非常非常长的中文文件名称测试.test.ts',
      '这是一个非常非常长的中文文件名称测试',
      '.test.ts'
    ],
    ['prefix-😀😀😀😀😀😀😀😀😀😀.ts', 'prefix-😀', '😀😀😀😀😀😀😀😀😀.ts'],
    ['verylongsinglewo\u0301\u0301rdname.ts', 'verylongsi', 'nglewo\u0301\u0301rdname.ts']
  ])('splits %j at the tail', (name, head, tail) => {
    expect(splitFileExplorerRowName(name)).toEqual([head, tail])
  })

  it.each(['a.ts', 'short.ts', 'ملف-طويل-جدا-للاختبار.ts', 'first\nsecond-and-tail.txt', ''])(
    'keeps %j whole',
    (name) => {
      expect(splitFileExplorerRowName(name)).toEqual([name, ''])
    }
  )
})
