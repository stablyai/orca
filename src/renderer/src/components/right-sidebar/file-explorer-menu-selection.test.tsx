// @vitest-environment happy-dom
import { useState, type PointerEvent as ReactPointerEvent } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { ContextMenu, ContextMenuTrigger } from '../ui/context-menu'
import { preventSecondaryMenuSelection } from '../ui/prevent-secondary-menu-selection'
import { FileExplorerBackgroundMenu } from './FileExplorerBackgroundMenu'
import { FileExplorerRowContextMenu } from './file-explorer-row-context-menu'

const DIRECTORY = '/workspace/subdir'
const DEPTH = 2
function ExplorerMenu({ row }: { row: boolean }) {
  const [open, setOpen] = useState(false)
  const [creation, setCreation] = useState<{ type: string; dir: string; depth: number } | null>(
    null
  )
  const onStartNew = (type: 'file' | 'folder', dir: string, depth: number) =>
    setCreation({ type, dir, depth })
  return (
    <>
      <input aria-label="Explorer focus" />
      <output aria-label="Creation target">{JSON.stringify(creation)}</output>
      {row ? (
        <ContextMenu>
          <ContextMenuTrigger>Directory row</ContextMenuTrigger>
          <FileExplorerRowContextMenu
            node={{
              name: 'subdir',
              path: DIRECTORY,
              relativePath: 'subdir',
              isDirectory: true,
              depth: DEPTH
            }}
            isExpanded
            targetDir={DIRECTORY}
            targetDepth={DEPTH}
            selectionSize={1}
            deleteShortcutLabel=""
            canOpenInOrcaBrowser={false}
            canCollapseFolderSubtree={false}
            canAddAsProject={false}
            onStartNew={onStartNew}
            onViewFile={() => {}}
            onCopyPaths={() => {}}
            onStartRename={() => {}}
            onDuplicate={() => {}}
            onAddFolderAsProject={() => {}}
            onOpenInTerminal={() => {}}
            onRequestDelete={() => {}}
            onCollapseFolderSubtree={() => {}}
            onFindInFolder={() => {}}
          />
        </ContextMenu>
      ) : (
        <>
          <div onContextMenu={() => setOpen(true)}>Directory row</div>
          <FileExplorerBackgroundMenu
            open={open}
            onOpenChange={setOpen}
            point={{ x: 16, y: 8 }}
            worktreePath={DIRECTORY}
            displayDepth={DEPTH}
            onStartNew={onStartNew}
          />
        </>
      )}
    </>
  )
}

afterEach(cleanup)

it.each([false, true])(
  'keeps explorer button-2 capture, directory/depth action and close focus (row=%s)',
  async (row) => {
    render(<ExplorerMenu row={row} />)
    const focus = screen.getByRole('textbox', { name: 'Explorer focus' })
    act(() => focus.focus())
    fireEvent.contextMenu(screen.getByText('Directory row'), { button: 2, clientX: 16, clientY: 8 })
    const item = await screen.findByRole('menuitem', { name: 'New File' })
    fireEvent.pointerUp(item, { button: 2, pointerId: 1, pointerType: 'mouse' })
    expect(screen.getByLabelText('Creation target').textContent).toBe('null')
    fireEvent.pointerDown(item, { button: 0, pointerId: 1, pointerType: 'mouse' })
    fireEvent.pointerUp(item, { button: 0, pointerId: 1, pointerType: 'mouse' })
    fireEvent.click(item)
    expect(JSON.parse(screen.getByLabelText('Creation target').textContent ?? 'null')).toEqual({
      type: 'file',
      dir: DIRECTORY,
      depth: DEPTH
    })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(document.activeElement).toBe(document.body)
  }
)

it.each([0, 1, 2])(
  'retains the original explorer capture input and propagation outcome for button %s',
  (button) => {
    const results: { prevented: boolean; bubbled: boolean }[] = []
    const original = (event: ReactPointerEvent) => {
      if (event.button === 2) {
        event.preventDefault()
        event.stopPropagation()
      }
    }
    for (const capture of [original, preventSecondaryMenuSelection]) {
      let bubbled = false
      const view = render(
        <div
          onPointerUp={() => {
            bubbled = true
          }}
        >
          <div onPointerUpCapture={capture}>Capture</div>
        </div>
      )
      const prevented = !fireEvent.pointerUp(screen.getByText('Capture'), { button, pointerId: 1 })
      results.push({ prevented, bubbled })
      view.unmount()
    }
    expect(results[1]).toEqual(results[0])
    expect(results[1]).toEqual({ prevented: button === 2, bubbled: button !== 2 })
  }
)
