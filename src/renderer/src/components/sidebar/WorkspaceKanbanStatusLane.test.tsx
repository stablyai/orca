// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { serializeWorkspaceLaneFullIds } from './workspace-kanban-filtered-drop-index'
import WorkspaceKanbanStatusLane from './WorkspaceKanbanStatusLane'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('./WorkspaceKanbanLaneCardList', () => ({
  default: ({
    items,
    activeWorktreeIdentity
  }: {
    items: readonly Worktree[]
    activeWorktreeIdentity: string | null
  }) => (
    <div data-active-worktree-identity={activeWorktreeIdentity ?? ''}>
      {items.map((item) => (
        <div key={item.id} data-workspace-board-card-id={item.id} />
      ))}
    </div>
  )
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null
}))

const status = { id: 'todo', label: 'Todo' }
const repoMap = new Map<string, Repo>()

function worktree(id: string): Worktree {
  return { id, repoId: 'repo-a', displayName: id } as Worktree
}

let container: HTMLDivElement
let root: Root

function renderLane(props: {
  items: Worktree[]
  totalCount: number
  hasQuery: boolean
  fullWorktreeIds?: string[]
  activeWorktreeIdentity?: string | null
}): void {
  act(() => {
    root.render(
      <WorkspaceKanbanStatusLane
        status={status}
        items={props.items}
        totalCount={props.totalCount}
        hasQuery={props.hasQuery}
        fullWorktreeIds={props.fullWorktreeIds}
        repoMap={repoMap}
        activeWorktreeIdentity={props.activeWorktreeIdentity ?? null}
        columnWidth={308}
        isResizingColumn={false}
        isDragTarget={false}
        renderCards={true}
        selectedWorktreeIds={new Set()}
        selectedWorktrees={[]}
        onDragOver={vi.fn()}
        onDragLeave={vi.fn()}
        onDrop={vi.fn()}
        onActivate={vi.fn()}
        onSelectionGesture={vi.fn(() => false)}
        onContextMenuSelect={vi.fn(() => [])}
        onCreateWorktree={vi.fn()}
        onColumnResizeStart={vi.fn()}
        onColumnResizeKeyDown={vi.fn()}
      />
    )
  })
}

function lane(): HTMLElement {
  const element = container.querySelector<HTMLElement>('[data-workspace-status-drop-target]')
  if (!element) {
    throw new Error('lane not rendered')
  }
  return element
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

describe('WorkspaceKanbanStatusLane', () => {
  it('shows a plain count without a query and a matches/total count with one', () => {
    renderLane({ items: [worktree('a'), worktree('b')], totalCount: 2, hasQuery: false })
    expect(container.textContent).toContain('2')
    expect(container.textContent).not.toContain('2 / 2')

    renderLane({ items: [worktree('a')], totalCount: 5, hasQuery: true })
    expect(container.textContent).toContain('1 / 5')
  })

  it('keeps a fully filtered lane as a labeled drop target', () => {
    renderLane({ items: [], totalCount: 5, hasQuery: true })

    expect(container.textContent).toContain('No matches')
    expect(lane().hasAttribute('data-workspace-status-drop-target')).toBe(true)
  })

  it('shows the empty placeholder when there is no query', () => {
    renderLane({ items: [], totalCount: 0, hasQuery: false })

    expect(container.textContent).toContain('Empty')
    expect(container.textContent).not.toContain('No matches')
  })

  it('leaves an already-empty lane as Empty under a query rather than "No matches"', () => {
    renderLane({ items: [], totalCount: 0, hasQuery: true, fullWorktreeIds: [] })

    expect(container.textContent).toContain('Empty')
    expect(container.textContent).not.toContain('No matches')
    expect(container.textContent).not.toContain('0 / 0')
  })

  it('publishes the full lane membership even when the rendered set is a subset', () => {
    renderLane({
      items: [worktree('b')],
      totalCount: 3,
      hasQuery: true,
      fullWorktreeIds: ['a', 'b', 'c']
    })

    expect(lane().dataset.workspaceLaneFullIds).toBe(serializeWorkspaceLaneFullIds(['a', 'b', 'c']))
    expect(container.querySelectorAll('[data-workspace-board-card-id]')).toHaveLength(1)
  })

  it('stays off the full-id channel when nothing is filtered', () => {
    // Why: without a query the rendered card scan already is the full lane, and
    // the attribute would carry every board id for no reader.
    renderLane({
      items: [worktree('a'), worktree('b')],
      totalCount: 2,
      hasQuery: false,
      fullWorktreeIds: ['a', 'b']
    })

    expect(lane().dataset.workspaceLaneFullIds).toBeUndefined()
  })

  it('passes the host-qualified active workspace through to the card list', () => {
    renderLane({
      items: [worktree('shared')],
      totalCount: 1,
      hasQuery: false,
      activeWorktreeIdentity: 'ssh:builder|shared'
    })

    expect(
      container.querySelector<HTMLElement>('[data-active-worktree-identity]')?.dataset
        .activeWorktreeIdentity
    ).toBe('ssh:builder|shared')
  })
})
