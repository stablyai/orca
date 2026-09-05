/** @vitest-environment happy-dom */
import { join } from 'node:path'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { HostSectionRow } from '../../host-section-rows'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { useSidebarWorktreeSelection, type SidebarWorktreeSelection } from './use-selection'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const MAX_PASSES = 400

function makeWorktree(id: string): Worktree {
  return {
    id,
    path: join(process.cwd(), 'repo', id),
    repoId: 'repo-1',
    hostId: 'local',
    createdAt: 0,
    sortOrder: 0
  } as unknown as Worktree
}

function makeSectionRows(worktrees: Worktree[]): HostSectionRow[] {
  return worktrees.map((worktree) => ({
    type: 'item',
    rowKey: `row:${worktree.hostId ?? 'local'}:${worktree.id}`,
    sectionKey: 'all',
    worktree,
    repo: undefined,
    depth: 0,
    groupDepth: 0,
    lineageTrail: [],
    isLastLineageChild: false,
    lineageChildCount: 0
  }))
}

let cleanup: (() => void) | null = null

afterEach(() => {
  cleanup?.()
  cleanup = null
})

describe('useSidebarWorktreeSelection cannot trigger React #185 loop', () => {
  it('drives selection via gestures, verifies outside pointerdown clears selection, and prunes stale items without render loops', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    cleanup = () => {
      act(() => root.unmount())
      container.remove()
    }

    let renderCount = 0
    let latestSelection: SidebarWorktreeSelection | null = null
    const renderedSnapshots: string[][] = []

    function SelectionHarness({ sectionRows }: { sectionRows: HostSectionRow[] }) {
      renderCount += 1
      if (renderCount > MAX_PASSES) {
        throw new Error('Maximum update depth exceeded')
      }
      const selection = useSidebarWorktreeSelection({
        sectionRows,
        pinnedDisplayPolicy: 'single-location'
      })
      latestSelection = selection
      renderedSnapshots.push(Array.from(selection.selectedWorktreeIds))

      return (
        <div data-worktree-sidebar-container="true">
          <div data-testid="count">{selection.selectedWorktreeIds.size}</div>
        </div>
      )
    }

    const wt1 = makeWorktree('wt-1')
    const wt2 = makeWorktree('wt-2')
    const wt3 = makeWorktree('wt-3')
    const wt4 = makeWorktree('wt-4')

    act(() => {
      root.render(<SelectionHarness sectionRows={makeSectionRows([wt1, wt2, wt3])} />)
    })
    expect(latestSelection).not.toBeNull()
    expect(latestSelection!.selectedWorktreeIds.size).toBe(0)

    act(() => {
      const mouseEvent = {
        metaKey: false,
        ctrlKey: false,
        shiftKey: false
      } as unknown as React.MouseEvent<HTMLElement>
      latestSelection!.updateSelectionForGesture(mouseEvent, wt1)
    })
    expect(latestSelection!.selectedWorktreeIds.size).toBe(1)
    expect(latestSelection!.selectedWorktreeIds.has(getWorktreeHostIdentity(wt1))).toBe(true)

    act(() => {
      const mouseEvent = {} as React.MouseEvent<HTMLElement>
      latestSelection!.selectForContextMenu(mouseEvent, wt2)
    })
    expect(latestSelection!.selectedWorktreeIds.has(getWorktreeHostIdentity(wt2))).toBe(true)
    expect(latestSelection!.selectedWorktreeIds.size).toBe(1)
    expect(latestSelection!.selectedWorktreeIds.has(getWorktreeHostIdentity(wt1))).toBe(false)

    act(() => {
      document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    })
    expect(latestSelection!.selectedWorktreeIds.size).toBe(0)

    act(() => {
      const mouseEvent = {} as React.MouseEvent<HTMLElement>
      latestSelection!.selectForContextMenu(mouseEvent, wt1)
    })
    expect(latestSelection!.selectedWorktreeIds.has(getWorktreeHostIdentity(wt1))).toBe(true)

    renderedSnapshots.length = 0
    act(() => {
      root.render(<SelectionHarness sectionRows={makeSectionRows([wt2, wt3])} />)
    })

    // Invariant: in EVERY render pass during and after filtering, children NEVER receive stale selected IDs
    expect(renderedSnapshots.length).toBeGreaterThan(0)
    for (const snapshot of renderedSnapshots) {
      expect(snapshot).not.toContain(getWorktreeHostIdentity(wt1))
    }
    expect(latestSelection!.selectedWorktreeIds.size).toBe(0)

    // Why single act: burst events before effect cleanup to verify redundant clears bail out.
    act(() => {
      latestSelection!.selectForContextMenu({} as React.MouseEvent<HTMLElement>, wt2)
    })
    expect(latestSelection!.selectedWorktreeIds.size).toBe(1)

    const rendersBeforeBurst = renderCount
    act(() => {
      for (let i = 0; i < 50; i += 1) {
        document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
      }
    })
    expect(latestSelection!.selectedWorktreeIds.size).toBe(0)
    // Why <= 2: functional guards bail out of redundant renders on already-empty state.
    expect(renderCount - rendersBeforeBurst).toBeLessThanOrEqual(2)

    for (let i = 0; i < 20; i += 1) {
      const selectedWorktree = i % 2 === 0 ? wt2 : wt1
      act(() => {
        latestSelection!.selectForContextMenu({} as React.MouseEvent<HTMLElement>, selectedWorktree)
      })
      expect(
        latestSelection!.selectedWorktreeIds.has(getWorktreeHostIdentity(selectedWorktree))
      ).toBe(true)

      const nextRows = i % 2 === 0 ? [wt1, wt3] : [wt2, wt4]
      act(() => {
        root.render(<SelectionHarness sectionRows={makeSectionRows(nextRows)} />)
      })
      expect(
        latestSelection!.selectedWorktreeIds.has(getWorktreeHostIdentity(selectedWorktree))
      ).toBe(false)
      expect(latestSelection!.selectedWorktreeIds.size).toBe(0)
    }

    expect(renderCount).toBeLessThan(MAX_PASSES)
  })
})
