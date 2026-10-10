// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  getWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity
} from '../../../../shared/worktree/host-qualified-identity'
import { useWorkspaceKanbanSelection } from './use-workspace-kanban-selection'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Selection = ReturnType<typeof useWorkspaceKanbanSelection>

function worktree(id: string): Worktree {
  return { id, repoId: 'repo-a', displayName: id, hostId: 'local' } as Worktree
}

const alpha = worktree('alpha')
const beta = worktree('beta')
const gamma = worktree('gamma')
const delta = worktree('delta')
const fullBoard = [alpha, beta, gamma, delta]

let container: HTMLDivElement
let root: Root
let selection: Selection

function Probe({
  board,
  rendered
}: {
  board: readonly Worktree[]
  rendered: readonly Worktree[]
}): null {
  selection = useWorkspaceKanbanSelection(true, board, rendered)
  return null
}

function renderSelection(
  rendered: readonly Worktree[] = fullBoard,
  board: readonly Worktree[] = fullBoard
): void {
  act(() => {
    root.render(<Probe board={board} rendered={rendered} />)
  })
}

function click(worktreeId: string, shiftKey = false): void {
  const identity = worktreeId.includes('|') ? worktreeId : `local|${worktreeId}`
  act(() => {
    selection.updateSelectionForGesture(
      { metaKey: false, ctrlKey: false, shiftKey } as React.MouseEvent<HTMLElement>,
      identity
    )
  })
}

function toggleClick(worktreeId: string): void {
  const identity = worktreeId.includes('|') ? worktreeId : `local|${worktreeId}`
  act(() => {
    selection.updateSelectionForGesture(
      {
        metaKey: navigator.userAgent.includes('Mac'),
        ctrlKey: !navigator.userAgent.includes('Mac'),
        shiftKey: false
      } as React.MouseEvent<HTMLElement>,
      identity
    )
  })
}

function selectedIds(): string[] {
  return [...selection.selectedWorktreeIds].map(getWorktreeIdFromHostIdentity).sort()
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

describe('useWorkspaceKanbanSelection', () => {
  it('ranges across the whole board when nothing is filtered', () => {
    renderSelection()

    click(alpha.id)
    click(gamma.id, true)

    expect(selectedIds()).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('never ranges through cards a search has hidden', () => {
    renderSelection([alpha, gamma])

    click(alpha.id)
    click(gamma.id, true)

    expect(selectedIds()).toEqual(['alpha', 'gamma'])
  })

  it('keeps a hidden card selected so clearing the search restores the selection', () => {
    renderSelection()
    click(alpha.id)
    click(beta.id, true)
    expect(selectedIds()).toEqual(['alpha', 'beta'])

    renderSelection([alpha])
    expect(selectedIds()).toEqual(['alpha', 'beta'])

    renderSelection()
    expect(selectedIds()).toEqual(['alpha', 'beta'])
  })

  it('extends the range from a visible card when a search hides the anchor', () => {
    // Anchor lands on delta, then a query hides only delta.
    renderSelection()
    click(alpha.id)
    toggleClick(beta.id)
    toggleClick(delta.id)
    expect(selectedIds()).toEqual(['alpha', 'beta', 'delta'])

    renderSelection([alpha, beta, gamma])
    click(gamma.id, true)

    // Without a rendered anchor this collapsed to just gamma, dropping the
    // still-visible alpha and beta along with it.
    expect(selectedIds()).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('replaces a hidden selection on every replace-shaped gesture alike', () => {
    // Why: a range, a plain click and a non-additive marquee all mean "replace".
    // If a range alone carried hidden cards through, the user would be left with
    // a selection they cannot see, count, or narrow.
    renderSelection()
    click(delta.id)
    toggleClick(alpha.id)
    expect(selectedIds()).toEqual(['alpha', 'delta'])

    renderSelection([alpha, beta, gamma])
    click(gamma.id, true)

    expect(selectedIds()).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('lets a plain click clear a selection the search is hiding', () => {
    renderSelection()
    click(alpha.id)
    toggleClick(delta.id)

    renderSelection([alpha, beta, gamma])
    click(beta.id)

    expect(selectedIds()).toEqual(['beta'])
  })

  it('still prunes ids that leave the board entirely', () => {
    renderSelection()
    click(alpha.id)
    click(gamma.id, true)

    renderSelection([alpha, beta], [alpha, beta])

    expect(selectedIds()).toEqual(['alpha', 'beta'])
  })

  it('selects same-id cards independently by host', () => {
    const local = worktree('shared')
    const remote = { ...local, hostId: 'ssh:host-b' } as Worktree
    renderSelection([local, remote], [local, remote])

    click(getWorktreeHostIdentity(local))
    expect([...selection.selectedWorktreeIds]).toEqual([getWorktreeHostIdentity(local)])
    expect(selection.selectedWorktrees).toEqual([local])

    toggleClick(getWorktreeHostIdentity(remote))
    expect(selection.selectedWorktreeIds).toEqual(
      new Set([getWorktreeHostIdentity(local), getWorktreeHostIdentity(remote)])
    )
    expect(selection.selectedWorktrees).toEqual([local, remote])
  })
})
