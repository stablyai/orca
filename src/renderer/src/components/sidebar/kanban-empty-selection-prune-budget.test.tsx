// @vitest-environment happy-dom

import React, { act, useEffect, useLayoutEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import { makeWorktree } from '../worktree-jump-palette-test-fixtures'
import * as policy from '@/lib/list-multi-selection'
import { useWorkspaceKanbanSelection } from './use-workspace-kanban-selection'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
type Selection = ReturnType<typeof useWorkspaceKanbanSelection>
type Props = { open: boolean; board: readonly Worktree[]; rendered: readonly Worktree[] }
let container: HTMLDivElement
let root: Root
let selection: Selection
let commits: { phase: 'layout' | 'effect'; ids: string[]; anchor: string | null }[]
let budget: { calls: number; ids: number }
let gestureReturn: boolean | undefined
let contextReturn: readonly Worktree[] | undefined

function Probe(props: Props): React.JSX.Element {
  selection = useWorkspaceKanbanSelection(props.open, props.board, props.rendered)
  const value = selection
  useLayoutEffect(() => {
    commits.push({
      phase: 'layout',
      ids: [...value.selectedWorktreeIds],
      anchor: value.selectionAnchorId
    })
  })
  useEffect(() => {
    commits.push({
      phase: 'effect',
      ids: [...value.selectedWorktreeIds],
      anchor: value.selectionAnchorId
    })
  })
  return (
    <div>
      <output>
        {JSON.stringify({ ids: [...value.selectedWorktreeIds], anchor: value.selectionAnchorId })}
      </output>
      {[...props.rendered, makeWorktree('missing', 'Missing', { hostId: 'local' })].map((row) => (
        <button
          key={getWorktreeHostIdentity(row)}
          data-id={getWorktreeHostIdentity(row)}
          onClick={(event) => {
            gestureReturn = value.updateSelectionForGesture(event, getWorktreeHostIdentity(row))
          }}
          onContextMenu={(event) => {
            contextReturn = value.selectForContextMenu(event, row)
          }}
        >
          {row.displayName}
        </button>
      ))}
    </div>
  )
}
function render(props: Props, strict = false): void {
  act(() => {
    root.render(
      strict ? (
        <React.StrictMode>
          <Probe {...props} />
        </React.StrictMode>
      ) : (
        <Probe {...props} />
      )
    )
  })
}
function event(id: string, type = 'click', options: MouseEventInit = {}): void {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.dataset.id === id
  )
  if (!button) {
    throw new Error(`Missing button ${id}`)
  }
  act(() => {
    button.dispatchEvent(new MouseEvent(type, { bubbles: true, ...options }))
  })
}
function state(board: readonly Worktree[], ids: readonly string[], anchor: string | null): void {
  expect([...selection.selectedWorktreeIds]).toEqual(ids)
  expect(selection.selectionAnchorId).toBe(anchor)
  const wanted = board.filter((row) => ids.includes(getWorktreeHostIdentity(row)))
  expect(selection.selectedWorktrees).toEqual(wanted)
  wanted.forEach((row, index) => expect(selection.selectedWorktrees[index]).toBe(row))
  expect(container.querySelector('output')?.textContent).toBe(JSON.stringify({ ids, anchor }))
  const layouts = commits
    .filter((commit) => commit.phase === 'layout')
    .map(({ ids, anchor }) => ({ ids, anchor }))
  const effects = commits
    .filter((commit) => commit.phase === 'effect')
    .map(({ ids, anchor }) => ({ ids, anchor }))
  expect(effects).toEqual(layouts)
  expect(commits.at(-2)?.phase).toBe('layout')
  expect(commits.at(-1)?.phase).toBe('effect')
}
function rows(count: number): Worktree[] {
  return Array.from({ length: count }, (_, index) =>
    makeWorktree(`row-${Math.floor(index / 2)}`, `Workspace ${index}`, {
      hostId: index % 2 ? 'ssh:box' : 'local'
    })
  )
}

beforeEach(() => {
  commits = []
  budget = { calls: 0, ids: 0 }
  gestureReturn = undefined
  contextReturn = undefined
  const original = policy.pruneSelection
  vi.spyOn(policy, 'pruneSelection').mockImplementation((selected, anchor, ids) => {
    budget.calls += 1
    const iterator = ids[Symbol.iterator]()
    const next = iterator.next.bind(iterator)
    const steps = vi.spyOn(iterator, 'next').mockImplementation(() => {
      const result = next()
      if (!result.done) {
        budget.ids += 1
      }
      return result
    })
    const iterate = vi.spyOn(ids, Symbol.iterator).mockReturnValue(iterator)
    try {
      return original(selected, anchor, ids)
    } finally {
      iterate.mockRestore()
      steps.mockRestore()
    }
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  vi.restoreAllMocks()
})

describe('Kanban empty selection pruning budget', () => {
  it.each([0, 1, 12, 1000])(
    'keeps complete idle state through 100 renders with %i rows without discarded pruning',
    (count) => {
      const board = Object.freeze(rows(count))
      const props: Props = { open: true, board, rendered: board }
      render(props)
      const initial = selection
      budget = { calls: 0, ids: 0 }
      for (let iteration = 0; iteration < 100; iteration += 1) {
        render(props)
        state(board, [], null)
        expect(selection.selectedWorktreeIds).toBe(initial.selectedWorktreeIds)
        expect(selection.selectedWorktrees).toBe(initial.selectedWorktrees)
        expect(selection.updateSelectionForGesture).toBe(initial.updateSelectionForGesture)
        expect(selection.updateSelectionForArea).toBe(initial.updateSelectionForArea)
        expect(selection.clearSelection).toBe(initial.clearSelection)
        expect(selection.selectForContextMenu).toBe(initial.selectForContextMenu)
      }
      expect(commits).toHaveLength(202)
      expect(budget).toEqual({ calls: 0, ids: 0 })
    }
  )

  it.each(['Macintosh', 'Windows NT', 'Linux'])(
    'preserves selection and anchor-only pruning on %s',
    (userAgent) => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent)
      const board = rows(12),
        identities = board.map(getWorktreeHostIdentity)
      const first = identities[0]!,
        remote = identities[1]!,
        last = identities.at(-1)!
      const toggle = { metaKey: userAgent === 'Macintosh', ctrlKey: userAgent !== 'Macintosh' }
      let props: Props = { open: true, board, rendered: board }
      render(props)
      event(first)
      expect(gestureReturn).toBe(false)
      event(remote, 'click', toggle)
      expect(gestureReturn).toBe(true)
      state(board, [first, remote], remote)
      event(remote, 'contextmenu')
      expect(contextReturn).toBe(selection.selectedWorktrees)
      state(board, [first, remote], remote)
      props = { ...props, rendered: board.slice(2) }
      render(props)
      state(board, [first, remote], remote)
      event(last, 'click', { shiftKey: true })
      expect(gestureReturn).toBe(true)
      state(board, [last], last)
      event(last, 'contextmenu')
      expect(contextReturn).toEqual([board.at(-1)])
      expect(contextReturn?.[0]).toBe(board.at(-1))
      act(() => {
        selection.updateSelectionForArea([identities[4]!], false)
      })
      state(board, [identities[4]!], identities[4]!)
      const beforeAdditive = selection.selectedWorktreeIds
      act(() => {
        selection.updateSelectionForArea([], true)
      })
      state(board, [identities[4]!], identities[4]!)
      expect(selection.selectedWorktreeIds).toBe(beforeAdditive)
      act(() => {
        selection.updateSelectionForArea([identities[3]!], true)
      })
      state(board, [identities[4]!, identities[3]!], identities[3]!)
      act(() => {
        selection.clearSelection()
      })
      props = { ...props, rendered: board }
      render(props)
      event(first)
      event(first, 'click', toggle)
      state(board, [], first)
      budget = { calls: 0, ids: 0 }
      render(props)
      const anchorBudget = { ...budget }
      props = { ...props, board: board.slice(1), rendered: board.slice(1) }
      render(props)
      state(props.board, [], null)
      event('local|missing')
      state(props.board, [], null)
      event(remote)
      props = { ...props, open: false }
      render(props)
      state(props.board, [], null)
      props = { ...props, open: true, board: board.toReversed(), rendered: board.toReversed() }
      render(props)
      event(last)
      state(props.board, [last], last)
      act(() => {
        selection.clearSelection()
      })
      const cleared = selection.selectedWorktreeIds
      act(() => {
        selection.clearSelection()
      })
      state(props.board, [], null)
      expect(selection.selectedWorktreeIds).toBe(cleared)
      expect(anchorBudget).toEqual({ calls: 1, ids: 12 })
    }
  )

  it('preserves StrictMode, scope replacement, remount and public helper freshness', () => {
    const board = [
      makeWorktree('', 'Empty'),
      makeWorktree('__proto__', 'Special', { hostId: 'local' }),
      makeWorktree('has|separator', 'Delimiter', { hostId: 'ssh:box' }),
      makeWorktree('same', 'Local', { hostId: 'local' }),
      makeWorktree('same', 'SSH', { hostId: 'ssh:box' })
    ]
    const ids = board.map(getWorktreeHostIdentity)
    const props: Props = { open: true, board, rendered: board }
    render(props, true)
    state(board, [], null)
    event(ids[0]!)
    event(ids[4]!, 'click', { shiftKey: true })
    state(board, ids, ids[0]!)
    act(() => {
      selection.clearSelection()
    })
    render({ ...props, board: [], rendered: [] }, true)
    state([], [], null)
    act(() => {
      root.render(null)
    })
    render({ ...props, rendered: [] })
    state(board, [], null)
    const a = policy.pruneSelection(new Set(), null, ids)
    const b = policy.pruneSelection(new Set(), null, ids)
    expect(a).toEqual(b)
    expect(a).not.toBe(b)
    expect(a.selectedIds).not.toBe(b.selectedIds)
  })
})
