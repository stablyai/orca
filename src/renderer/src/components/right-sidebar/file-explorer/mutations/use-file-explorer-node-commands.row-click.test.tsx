// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../../shared/execution-host'
import { createFileExplorerRowProjection } from '../tree/file-explorer-row-projection'
import type { TreeNode } from '../tree/file-explorer-types'
import { useFileExplorerNodeCommands } from './use-file-explorer-node-commands'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

const fileNode: TreeNode = {
  name: 'a.ts',
  path: '/repo/a.ts',
  relativePath: 'a.ts',
  isDirectory: false,
  depth: 0
}

const handleClick = vi.fn()

function Harness(): React.JSX.Element {
  const { handleRowClick } = useFileExplorerNodeCommands({
    activeWorktreeId: 'wt-1',
    worktreePath: '/repo',
    activeRepo: null,
    containerRef: { current: null },
    rowProjection: createFileExplorerRowProjection([fileNode]),
    rowExpandedPaths: new Set(),
    selectedPaths: new Set(),
    selectedNode: null,
    selectRowWithModifiers: (node, _event, onReplaceClick) => onReplaceClick(node),
    moveSelection: vi.fn(),
    inlineInput: null,
    startRename: vi.fn(),
    requestDelete: vi.fn(),
    requestDeleteAll: vi.fn(),
    refreshDir: vi.fn(),
    handleClick,
    toggleDir: vi.fn(),
    scrollToIndex: vi.fn(),
    pathOwner: LOCAL_EXECUTION_HOST_ID
  })
  return <button onClick={(event) => handleRowClick(fileNode, event)}>row</button>
}

let container: HTMLDivElement
let root: Root

function clickRowWithDetail(detail: number): void {
  const button = container.querySelector('button')
  if (!button) {
    throw new Error('row did not render')
  }
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail }))
  })
}

beforeEach(() => {
  handleClick.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(<Harness />))
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('useFileExplorerNodeCommands row clicks', () => {
  it('marks a mouse click as a row click, repeated from the second click of a double-click', () => {
    clickRowWithDetail(1)
    clickRowWithDetail(2)

    expect(handleClick.mock.calls).toEqual([
      [fileNode, { repeated: false }],
      [fileNode, { repeated: true }]
    ])
  })

  it('does not mark a keyboard-generated click (detail 0) as a row click', () => {
    clickRowWithDetail(0)

    expect(handleClick.mock.calls).toEqual([[fileNode, undefined]])
  })
})
