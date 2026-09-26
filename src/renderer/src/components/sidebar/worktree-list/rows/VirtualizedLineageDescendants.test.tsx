// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeCardProps } from '../../worktree-card-model'
import { lineageContext, lineageRow } from './lineage-virtualization-test-fixtures'
import { VirtualizedLineageDescendants } from './VirtualizedLineageDescendants'
import { clearWorktreeAgentExpansionStateForTests } from '../../worktree-card-agents-expansion-state'

const windowState = vi.hoisted(() => ({ start: 0, count: 20 }))
const storeState = vi.hoisted<{
  renamingWorktreeId: { worktreeId: string; rowKey?: string } | null
}>(() => ({ renamingWorktreeId: null }))
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from(
        { length: Math.max(0, Math.min(windowState.count, count - windowState.start)) },
        (_, n) => ({
          index: windowState.start + n
        })
      )
  })
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof storeState) => unknown) => selector(storeState)
}))
vi.mock('../../WorktreeCard', async () => {
  const { useWorktreeAgentExpansionState } =
    await import('../../worktree-card-agents-expansion-state')
  return {
    default: function MockWorktreeCard({
      worktree,
      lineageChildren,
      onImmediateActivate,
      activationRowKey
    }: WorktreeCardProps) {
      const expansion = useWorktreeAgentExpansionState(worktree.id)
      return (
        <section
          data-mounted-card={worktree.id}
          onClick={() => onImmediateActivate?.(worktree.id, activationRowKey)}
        >
          <button
            type="button"
            onClick={expansion.toggleCompactRootList}
            aria-expanded={expansion.compactRootListExpanded}
          >
            Agents {worktree.id}
          </button>
          {lineageChildren}
        </section>
      )
    }
  }
})

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  storeState.renamingWorktreeId = null
  windowState.start = 0
  windowState.count = 20
  clearWorktreeAgentExpansionStateForTests()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

const wideRows = () => [
  lineageRow('root', 0),
  ...Array.from({ length: 500 }, (_, n) => lineageRow(`child-${n}`))
]
const mountedIds = () =>
  [...container.querySelectorAll<HTMLElement>('[data-mounted-card]')].map(
    (element) => element.dataset.mountedCard
  )

async function renderRows(rows = wideRows(), ctx = lineageContext()): Promise<void> {
  await act(async () =>
    root.render(
      <VirtualizedLineageDescendants rows={rows} ctx={ctx} groupStart={0} groupKey="test-lineage" />
    )
  )
}

describe('lineage card virtualization', () => {
  it('mounts only the descendant window and advances through a 500-child lineage', async () => {
    const rows = wideRows()
    await renderRows(rows)
    expect(mountedIds()).toEqual(Array.from({ length: 20 }, (_, n) => `child-${n}`))
    expect(container.querySelectorAll('[data-lineage-virtual-spacer]')).toHaveLength(1)
    windowState.start = 240
    await renderRows(rows)
    expect(mountedIds()).toEqual(Array.from({ length: 20 }, (_, n) => `child-${240 + n}`))
    expect(container.querySelectorAll('[data-lineage-virtual-spacer]')).toHaveLength(2)
  })

  it('retains ancestor surfaces for visible descendants without mounting their hidden siblings', async () => {
    const rows = [
      lineageRow('root', 0),
      lineageRow('parent'),
      ...Array.from({ length: 500 }, (_, n) => lineageRow(`child-${n}`, 2))
    ]
    windowState.start = 201
    await renderRows(rows)
    expect(mountedIds()).toEqual([
      'parent',
      ...Array.from({ length: 20 }, (_, n) => `child-${200 + n}`)
    ])
    expect(
      container.querySelector('[data-mounted-card="parent"] [data-mounted-card="child-200"]')
    ).not.toBeNull()
    const ctx = lineageContext()
    await act(async () =>
      root.render(
        <VirtualizedLineageDescendants
          rows={rows}
          ctx={ctx}
          groupStart={0}
          groupKey="test-lineage"
        />
      )
    )
    await act(async () =>
      container.querySelector<HTMLElement>('[data-mounted-card="child-200"]')!.click()
    )
    expect(ctx.item.onImmediateActivate).toHaveBeenCalledExactlyOnceWith(
      'child-200',
      'all:|child-200'
    )
  })

  it('keeps the interaction owner mounted offscreen and restores another card’s expansion after recycling', async () => {
    const rows = wideRows()
    const ctx = lineageContext()
    await renderRows(rows, ctx)
    const first = container.querySelector<HTMLButtonElement>(
      '[data-mounted-card="child-0"] button'
    )!
    await act(async () => {
      first.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
      first.click()
    })
    const second = container.querySelector<HTMLButtonElement>(
      '[data-mounted-card="child-1"] button'
    )!
    await act(async () => second.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })))
    windowState.start = 240
    await renderRows(rows, ctx)
    expect(mountedIds()).toHaveLength(21)
    expect(mountedIds()).toContain('child-1')
    expect(mountedIds()).not.toContain('child-0')
    windowState.start = 0
    await renderRows(rows, ctx)
    expect(
      container.querySelector('[data-mounted-card="child-0"] button')?.getAttribute('aria-expanded')
    ).toBe('true')
  })

  it('mounts an exact host-qualified pending reveal outside the window', async () => {
    const rows = wideRows()
    rows[401]!.worktree.hostId = 'ssh:remote'
    const ctx = lineageContext()
    ctx.pendingRevealWorktree = {
      worktreeId: 'child-400',
      executionHostId: 'local',
      behavior: 'auto',
      highlight: false,
      beginRename: false
    }
    await renderRows(rows, ctx)
    expect(mountedIds()).not.toContain('child-400')
    ctx.pendingRevealWorktree = { ...ctx.pendingRevealWorktree, executionHostId: 'ssh:remote' }
    await renderRows(rows, ctx)
    expect(mountedIds()).toContain('child-400')
    expect(mountedIds()).toContain('child-390')
    expect(mountedIds()).toContain('child-410')
    expect(mountedIds()).toHaveLength(41)
    ctx.pendingRevealWorktree = null
    await renderRows(rows, ctx)
    expect(mountedIds()).not.toContain('child-400')
    expect(mountedIds()).toHaveLength(20)
  })

  it('removes collapsed descendants without confusing the next sibling identity', async () => {
    const rows = [
      lineageRow('root', 0),
      lineageRow('parent'),
      lineageRow('child', 2),
      lineageRow('next')
    ]
    await renderRows(rows)
    expect(mountedIds()).toEqual(['parent', 'child', 'next'])
    await renderRows([rows[0]!, { ...rows[1]!, lineageCollapsed: true }, rows[3]!])
    expect(mountedIds()).toEqual(['parent', 'next'])
  })

  it('retains active and renamed rows by host and row identity outside the window', async () => {
    const rows = wideRows()
    rows[401]!.worktree.hostId = 'ssh:remote'
    rows[402]!.worktree = { ...rows[402]!.worktree, id: 'child-400', hostId: 'local' }
    const ctx = lineageContext()
    ctx.activeWorktreeId = 'child-400'
    await renderRows(rows, ctx)
    expect(container.querySelector('[data-lineage-virtual-item="all:|child-400"]')).toBeNull()
    expect(container.querySelector('[data-lineage-virtual-item="all:|child-401"]')).not.toBeNull()

    storeState.renamingWorktreeId = { worktreeId: 'child-400', rowKey: 'all:|child-400' }
    await renderRows(rows, ctx)
    expect(container.querySelector('[data-lineage-virtual-item="all:|child-400"]')).not.toBeNull()
    expect(mountedIds()).toHaveLength(22)
    storeState.renamingWorktreeId = null
    ctx.activeWorktreeId = 'root'
    await renderRows(rows, ctx)
    expect(mountedIds()).toHaveLength(20)
  })

  it.each(['focusin', 'contextmenu'])(
    'keeps the %s owner mounted while scrolling through descendants',
    async (eventName) => {
      const rows = wideRows()
      await renderRows(rows)
      await act(async () => {
        container
          .querySelector('[data-mounted-card="child-0"] button')!
          .dispatchEvent(new Event(eventName, { bubbles: true }))
      })
      windowState.start = 240
      await renderRows(rows)
      expect(mountedIds()).toContain('child-0')
      expect(mountedIds()).toHaveLength(21)
    }
  )
})
