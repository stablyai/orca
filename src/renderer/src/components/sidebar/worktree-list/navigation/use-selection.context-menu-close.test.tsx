// @vitest-environment happy-dom

import { useEffect } from 'react'
import type React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { HostSectionRow } from '../../host-section-rows'
import { worktree as worktreeFixture } from '../../worktree-list-groups-test-fixtures'
import { useSidebarWorktreeSelection } from './use-selection'

type Selection = ReturnType<typeof useSidebarWorktreeSelection>

function makeWorktree(id: string): Worktree {
  return { ...worktreeFixture, id, path: `/repo/${id}`, displayName: id, hostId: 'local' }
}

function row(worktree: Worktree): HostSectionRow {
  return {
    type: 'item',
    rowKey: `row:${worktree.id}`,
    sectionKey: 'all',
    worktree,
    repo: undefined,
    depth: 0,
    groupDepth: 0,
    lineageTrail: [],
    isLastLineageChild: false,
    lineageChildCount: 0
  }
}

const alpha = makeWorktree('alpha')
const beta = makeWorktree('beta')
const worktrees = [alpha, beta]
const rows = worktrees.map(row)
const isMac = navigator.userAgent.includes('Mac')
let selection: Selection

function Probe(): React.JSX.Element {
  selection = useSidebarWorktreeSelection({
    sectionRows: rows,
    pinnedDisplayPolicy: 'single-location'
  })
  return (
    <>
      {worktrees.map((worktree) => (
        <div
          key={worktree.id}
          data-testid={worktree.id}
          onClick={(event) => selection.updateSelectionForGesture(event, worktree)}
          onContextMenu={(event) => selection.selectForContextMenu(event, worktree)}
        />
      ))}
    </>
  )
}

const CLOSE_ALL = 'test-close-all-context-menus'

// Mirrors the card menu: every mounted card closes on the broadcast, then the right-clicked one selects.
function MenuRow({ worktree }: { worktree: Worktree }): React.JSX.Element {
  useEffect(() => {
    const close = (): void => selection.clearContextMenuSelection(worktree)
    window.addEventListener(CLOSE_ALL, close)
    return () => window.removeEventListener(CLOSE_ALL, close)
  }, [worktree])
  return (
    <div
      data-testid={worktree.id}
      onClick={(event) => selection.updateSelectionForGesture(event, worktree)}
      onContextMenu={(event) => {
        window.dispatchEvent(new Event(CLOSE_ALL))
        selection.selectForContextMenu(event, worktree)
      }}
    />
  )
}

function MenuProbe(): React.JSX.Element {
  selection = useSidebarWorktreeSelection({
    sectionRows: rows,
    pinnedDisplayPolicy: 'single-location'
  })
  return (
    <>
      {worktrees.map((worktree) => (
        <MenuRow key={worktree.id} worktree={worktree} />
      ))}
    </>
  )
}

function closeAllMenus(): void {
  act(() => {
    window.dispatchEvent(new Event(CLOSE_ALL))
  })
}

function selectedIds(): string[] {
  return selection.selectedWorktrees.map((worktree) => worktree.id)
}

function addToSelection(worktree: Worktree): void {
  fireEvent.click(screen.getByTestId(worktree.id), { metaKey: isMac, ctrlKey: !isMac })
}

afterEach(() => {
  cleanup()
})

describe('sidebar selection when a row context menu closes', () => {
  it('clears the single-row selection the context menu created', () => {
    render(<Probe />)

    fireEvent.contextMenu(screen.getByTestId('beta'))
    expect(selectedIds()).toEqual(['beta'])

    act(() => selection.clearContextMenuSelection(beta))
    expect(selectedIds()).toEqual([])
  })

  it('keeps a multi-selection the context menu was opened inside', () => {
    render(<Probe />)
    addToSelection(alpha)
    addToSelection(beta)

    fireEvent.contextMenu(screen.getByTestId('beta'))
    act(() => selection.clearContextMenuSelection(beta))

    expect(selectedIds()).toEqual(['alpha', 'beta'])
  })

  it('keeps a selection the user changed while the menu was open', () => {
    render(<Probe />)

    fireEvent.contextMenu(screen.getByTestId('beta'))
    addToSelection(alpha)
    act(() => selection.clearContextMenuSelection(beta))

    expect(selectedIds()).toEqual(['alpha', 'beta'])
  })

  it('keeps the row once the user re-selects it while the menu was open', () => {
    render(<Probe />)

    fireEvent.contextMenu(screen.getByTestId('beta'))
    act(() => selection.selectOnly(beta))
    act(() => selection.clearContextMenuSelection(beta))

    expect(selectedIds()).toEqual(['beta'])
  })

  it('ignores a close from a different row', () => {
    render(<Probe />)

    fireEvent.contextMenu(screen.getByTestId('beta'))
    act(() => selection.clearContextMenuSelection(alpha))

    expect(selectedIds()).toEqual(['beta'])
  })

  it('keeps the close callback identity stable across selection changes', () => {
    render(<Probe />)
    const initial = selection.clearContextMenuSelection

    fireEvent.contextMenu(screen.getByTestId('beta'))
    addToSelection(alpha)

    expect(selection.clearContextMenuSelection).toBe(initial)
  })

  it('keeps a row the user re-selects with a click after an earlier menu cleared it', () => {
    render(<Probe />)
    fireEvent.contextMenu(screen.getByTestId('beta'))
    act(() => selection.clearContextMenuSelection(beta))
    expect(selectedIds()).toEqual([])

    addToSelection(beta)
    fireEvent.contextMenu(screen.getByTestId('beta'))
    act(() => selection.clearContextMenuSelection(beta))

    expect(selectedIds()).toEqual(['beta'])
  })

  it('keeps a row the user selected before opening its menu', () => {
    render(<Probe />)
    addToSelection(beta)

    fireEvent.contextMenu(screen.getByTestId('beta'))
    act(() => selection.clearContextMenuSelection(beta))

    expect(selectedIds()).toEqual(['beta'])
  })
})

describe('sidebar selection when every card menu closes on a new right-click', () => {
  it('keeps the newly right-clicked row while the previous menu closes', () => {
    render(<MenuProbe />)

    fireEvent.contextMenu(screen.getByTestId('beta'))
    fireEvent.contextMenu(screen.getByTestId('alpha'))
    expect(selectedIds()).toEqual(['alpha'])

    closeAllMenus()
    expect(selectedIds()).toEqual([])
  })

  it('still clears when the same row is right-clicked again while its menu is open', () => {
    render(<MenuProbe />)

    fireEvent.contextMenu(screen.getByTestId('beta'))
    fireEvent.contextMenu(screen.getByTestId('beta'))
    expect(selectedIds()).toEqual(['beta'])

    closeAllMenus()
    expect(selectedIds()).toEqual([])
  })

  it('keeps a user-selected row through the close broadcast', () => {
    render(<MenuProbe />)
    addToSelection(beta)

    fireEvent.contextMenu(screen.getByTestId('beta'))
    closeAllMenus()

    expect(selectedIds()).toEqual(['beta'])
  })
})
