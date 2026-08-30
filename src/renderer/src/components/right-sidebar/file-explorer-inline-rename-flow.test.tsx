// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { useRef } from 'react'
import { InlineInputRow } from './file-explorer-inline-input-row'
import { createFileExplorerRowProjection } from './file-explorer-row-projection'
import type { TreeNode } from './file-explorer-types'
import { useFileExplorerInlineInput } from './useFileExplorerInlineInput'

const mocks = vi.hoisted(() => ({
  openFile: vi.fn(),
  refreshDir: vi.fn().mockResolvedValue(undefined),
  renameFileOnDisk: vi.fn().mockResolvedValue(undefined),
  toggleDir: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ openFile: mocks.openFile, toggleDir: mocks.toggleDir })
}))

vi.mock('@/lib/rename-file', () => ({
  renameFileOnDisk: mocks.renameFileOnDisk
}))

const node: TreeNode = {
  name: 'components',
  path: '/repo/src/components',
  relativePath: 'src/components',
  isDirectory: true,
  depth: 1
}
const rowProjection = createFileExplorerRowProjection([node])

function RenameHarness(): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const { inlineInput, startRename, dismissInlineInput, handleInlineSubmit } =
    useFileExplorerInlineInput({
      activeWorktreeId: 'wt-1',
      worktreePath: '/repo',
      expanded: new Set(),
      rowProjection,
      scrollRef,
      refreshDir: mocks.refreshDir
    })

  return (
    <div ref={scrollRef} tabIndex={-1}>
      <button type="button" onClick={() => startRename(node)}>
        Rename
      </button>
      {inlineInput ? (
        <InlineInputRow
          depth={inlineInput.depth}
          inlineInput={inlineInput}
          onSubmit={handleInlineSubmit}
          onCancel={dismissInlineInput}
        />
      ) : null}
      <button type="button">Another row</button>
    </div>
  )
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms)
    await Promise.resolve()
  })
}

async function startSettledRename(): Promise<{
  input: HTMLInputElement
  outsideRow: HTMLButtonElement
}> {
  const view = render(<RenameHarness />)
  fireEvent.click(view.getByRole('button', { name: 'Rename' }))
  await advance(0)
  await advance(250)
  return {
    input: view.getByRole('textbox') as HTMLInputElement,
    outsideRow: view.getByRole('button', { name: 'Another row' }) as HTMLButtonElement
  }
}

describe('file explorer inline rename flow', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('renames on disk when focus leaves the input', async () => {
    const { input, outsideRow } = await startSettledRename()

    fireEvent.change(input, { target: { value: 'renamed-components' } })
    fireEvent.blur(input, { relatedTarget: outsideRow })
    await advance(150)

    expect(mocks.renameFileOnDisk).toHaveBeenCalledWith({
      oldPath: node.path,
      newName: 'renamed-components',
      worktreeId: 'wt-1',
      worktreePath: '/repo',
      operationOwner: undefined,
      refreshDir: mocks.refreshDir
    })
  })

  it('discards the rename on Escape without touching disk', async () => {
    const { input } = await startSettledRename()

    fireEvent.change(input, { target: { value: 'renamed-components' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    await advance(200)

    expect(mocks.renameFileOnDisk).not.toHaveBeenCalled()
  })
})
