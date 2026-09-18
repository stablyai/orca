// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { HostSectionRow } from '../../host-section-rows'
import { useSidebarWorktreeSelection } from './use-selection'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Selection = ReturnType<typeof useSidebarWorktreeSelection>

function worktree(id: string): Worktree {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: selection reads only id and hostId off a worktree; a literal Worktree would pin ~50 unrelated fields.
  return { id, repoId: 'repo', hostId: 'local' } as unknown as Worktree
}

function row(item: Worktree): HostSectionRow {
  return {
    type: 'item',
    rowKey: `row:${item.id}`,
    sectionKey: 'all',
    worktree: item,
    repo: undefined,
    depth: 0,
    groupDepth: 0,
    lineageTrail: [],
    isLastLineageChild: false,
    lineageChildCount: 0
  }
}

function unqualifiedWorktree(id: string): Worktree {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: same narrow shape as worktree(), without the hostId a local row never carries.
  return { id, repoId: 'repo' } as unknown as Worktree
}

const first = worktree('a')
const second = worktree('b')
const rows = [row(first), row(second)]

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: getWorktreeSelectionIntent reads only these three modifier flags off the event.
const additiveEvent = {
  metaKey: navigator.userAgent.includes('Mac'),
  ctrlKey: !navigator.userAgent.includes('Mac'),
  shiftKey: false
} as React.MouseEvent<HTMLElement>

let container: HTMLDivElement
let root: Root
let selection: Selection

// Declared once so a re-render updates the tree: a component type created per call would
// remount it, and the hook state under test would reset every time.
function Probe(props: { activeWorktreeId: string | null; hostId: ExecutionHostId | null }): null {
  selection = useSidebarWorktreeSelection({
    sectionRows: rows,
    pinnedDisplayPolicy: 'single-location',
    activeWorktreeId: props.activeWorktreeId,
    activeWorkspaceExecutionHostId: props.hostId
  })
  return null
}

function UnqualifiedProbe(props: {
  rows: HostSectionRow[]
  activeWorktreeId: string | null
  hostId: ExecutionHostId | null
}): null {
  selection = useSidebarWorktreeSelection({
    sectionRows: props.rows,
    pinnedDisplayPolicy: 'single-location',
    activeWorktreeId: props.activeWorktreeId,
    activeWorkspaceExecutionHostId: props.hostId
  })
  return null
}

function renderUnqualifiedProbe(
  unqualifiedRows: HostSectionRow[],
  activeWorktreeId: string | null,
  hostId: ExecutionHostId | null
): void {
  act(() =>
    root.render(
      <UnqualifiedProbe
        rows={unqualifiedRows}
        activeWorktreeId={activeWorktreeId}
        hostId={hostId}
      />
    )
  )
}

function renderProbe(activeWorktreeId: string | null, hostId: ExecutionHostId | null): void {
  act(() => root.render(<Probe activeWorktreeId={activeWorktreeId} hostId={hostId} />))
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('sidebar selection follows a non-gesture activation', () => {
  it('leaves the selection empty on the first activation it observes', () => {
    // Startup activates a workspace nobody picked; inventing a selection there would arm
    // Cmd+click from a card the user never touched.
    renderProbe('a', 'local')

    expect(selection.selectedWorktreeIds.size).toBe(0)
  })

  it('republishes the selection when the active workspace moves', () => {
    // The reported bug: keyboard cycling activated the next card while the ring stayed on
    // whichever card the mouse last clicked.
    renderProbe('a', 'local')
    act(() => selection.updateSelectionForGesture(additiveEvent, first))
    expect(selection.selectedWorktreeIds).toEqual(new Set(['local|a']))

    renderProbe('b', 'local')

    expect(selection.selectedWorktreeIds).toEqual(new Set(['local|b']))
    expect(selection.selectedWorktrees.map((item) => item.id)).toEqual(['b'])
  })

  it('keeps a multi-selection that a modifier gesture built without activating', () => {
    renderProbe('a', 'local')
    act(() => selection.updateSelectionForGesture(additiveEvent, first))
    act(() => selection.updateSelectionForGesture(additiveEvent, second))
    expect(selection.selectedWorktreeIds.size).toBe(2)

    // A modifier gesture selects without switching away, so the active workspace is unchanged.
    renderProbe('a', 'local')

    expect(selection.selectedWorktreeIds).toEqual(new Set(['local|a', 'local|b']))
  })

  it('publishes an identity the rendered rows actually carry', () => {
    // Local rows carry no hostId (withRepoHostOwnership leaves them unqualified) while the
    // store still resolves the active host to 'local'. Composing the two would publish an
    // identity no row has, and the render-phase prune would drop the selection entirely.
    const unqualified = unqualifiedWorktree('c')
    const unqualifiedRows = [row(unqualified), row(unqualifiedWorktree('d'))]

    renderUnqualifiedProbe(unqualifiedRows, 'c', 'local')
    act(() => selection.updateSelectionForGesture(additiveEvent, unqualified))
    expect(selection.selectedWorktreeIds).toEqual(new Set(['|c']))

    renderUnqualifiedProbe(unqualifiedRows, 'd', 'local')

    expect(selection.selectedWorktreeIds).toEqual(new Set(['|d']))
  })

  it('keeps the resolved host when rows disambiguate one id across hosts', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: selection reads only id and hostId.
    const onLocal = { id: 'shared', repoId: 'repo', hostId: 'local' } as unknown as Worktree
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: selection reads only id and hostId.
    const onRemote = { id: 'shared', repoId: 'repo', hostId: 'ssh:host-b' } as unknown as Worktree
    const sharedRows = [
      { ...row(onLocal), rowKey: 'row:local' },
      { ...row(onRemote), rowKey: 'row:remote' }
    ]

    // One workspace id present on two hosts: activating the remote one must not land on the
    // local row, so the resolved host has to survive when a row actually carries it.
    renderUnqualifiedProbe(sharedRows, 'shared', 'local')
    renderUnqualifiedProbe(sharedRows, 'shared', 'ssh:host-b')

    expect(selection.selectedWorktreeIds).toEqual(new Set(['ssh:host-b|shared']))
  })

  it('still publishes after the active workspace was hidden from the rows', () => {
    // Collapsing a group or filtering the list drops the active workspace from the rows, so the
    // identity resolves to null. The next activation still has to move the ring.
    const hidden = worktree('h')
    const picked = worktree('v')
    const target = worktree('w')
    const all = [row(hidden), row(picked), row(target)]
    const withoutHidden = [row(picked), row(target)]

    renderUnqualifiedProbe(all, 'h', 'local')
    // A modifier gesture leaves the ring on a card that is not the active one.
    act(() => selection.updateSelectionForGesture(additiveEvent, picked))
    expect(selection.selectedWorktreeIds).toEqual(new Set(['local|v']))

    // The active workspace drops out of the rows, so its identity resolves to null.
    renderUnqualifiedProbe(withoutHidden, 'h', 'local')
    // The next activation must still move the ring off the picked card.
    renderUnqualifiedProbe(withoutHidden, 'w', 'local')

    expect(selection.selectedWorktreeIds).toEqual(new Set(['local|w']))
  })

  it('publishes nothing when startup restores the active workspace asynchronously', () => {
    // The store starts with activeWorktreeId null and WorktreeList mounts before hydration
    // restores it, so the restore must read as startup rather than as a move.
    renderProbe(null, null)

    renderProbe('a', 'local')

    expect(selection.selectedWorktreeIds).toEqual(new Set())
  })

  it('treats the same workspace as a move after everything was deactivated', () => {
    const active = worktree('h')
    const picked = worktree('v')
    const both = [row(active), row(picked)]

    renderUnqualifiedProbe(both, 'h', 'local')
    act(() => selection.updateSelectionForGesture(additiveEvent, picked))
    // Deactivating everything ends the current activation.
    renderUnqualifiedProbe(both, null, null)

    renderUnqualifiedProbe(both, 'h', 'local')

    expect(selection.selectedWorktreeIds).toEqual(new Set(['local|h']))
  })

  it('republishes when the active row is re-qualified under an unchanged activation', () => {
    // Discovery backfill can stamp hostId on a row, turning `|id` into `local|id` while the
    // store's activation is unchanged. The published identity would otherwise be pruned away.
    const unqualified = [row(unqualifiedWorktree('a')), row(unqualifiedWorktree('b'))]
    const qualified = [row(worktree('a')), row(worktree('b'))]

    renderUnqualifiedProbe(unqualified, 'a', 'local')
    act(() => selection.updateSelectionForGesture(additiveEvent, unqualifiedWorktree('b')))
    expect(selection.selectedWorktreeIds).toEqual(new Set(['|b']))

    renderUnqualifiedProbe(qualified, 'a', 'local')

    expect(selection.selectedWorktreeIds).toEqual(new Set(['local|a']))
  })

  it('treats a round trip through a hidden workspace as a move', () => {
    // The palette can activate a workspace a filter is hiding. Coming back to the one before
    // it is still two activations, so the ring must not stay where a gesture put it.
    const origin = worktree('a')
    const picked = worktree('v')
    const visible = [row(origin), row(picked)]

    renderUnqualifiedProbe(visible, 'a', 'local')
    act(() => selection.updateSelectionForGesture(additiveEvent, picked))
    // 'b' is not among the rendered rows, so its identity never resolves.
    renderUnqualifiedProbe(visible, 'b', 'local')

    renderUnqualifiedProbe(visible, 'a', 'local')

    expect(selection.selectedWorktreeIds).toEqual(new Set(['local|a']))
  })

  it('does not republish when a hidden row simply comes back', () => {
    // Clearing a filter or expanding a group is not an activation, so a selection the user
    // built deliberately has to survive the active row reappearing.
    const hidden = worktree('h')
    const picked = worktree('v')
    const all = [row(hidden), row(picked)]
    const withoutHidden = [row(picked)]

    renderUnqualifiedProbe(all, 'h', 'local')
    act(() => selection.updateSelectionForGesture(additiveEvent, picked))
    renderUnqualifiedProbe(withoutHidden, 'h', 'local')

    renderUnqualifiedProbe(all, 'h', 'local')

    expect(selection.selectedWorktreeIds).toEqual(new Set(['local|v']))
  })

  it('resolves a host-unqualified activation through the rendered rows', () => {
    renderProbe('a', null)
    act(() => selection.updateSelectionForGesture(additiveEvent, first))

    renderProbe('b', null)

    expect(selection.selectedWorktreeIds).toEqual(new Set(['local|b']))
  })
})
