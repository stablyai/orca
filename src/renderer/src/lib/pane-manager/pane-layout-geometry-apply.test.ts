// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { PaneManagerOptions } from './pane-manager-types'
import type { TerminalPaneLayoutNode } from '../../../../shared/workspace-layout/terminal-tab-types'
import { serializePaneTree } from '@/components/terminal-pane/layout/terminal-layout-dom-serialization'

// Why: happy-dom has no canvas, so xterm cannot open; geometry never touches the terminal.
vi.mock('./pane-lifecycle', async (importOriginal) => {
  const actual: object = await importOriginal()
  return { ...actual, openTerminal: vi.fn() }
})

const { PaneManager } = await import('./pane-manager')

const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'

const leaf = (leafId: string): TerminalPaneLayoutNode => ({ type: 'leaf', leafId })

describe('PaneManager.applyLayoutGeometry', () => {
  let root: HTMLDivElement
  let onLayoutChanged: Mock<NonNullable<PaneManagerOptions['onLayoutChanged']>>
  let manager: InstanceType<typeof PaneManager>

  function mountTwoPanes(direction: 'vertical' | 'horizontal', ratio?: number): void {
    const first = manager.createInitialPane({ leafId: LEAF_A })
    manager.splitPane(first.id, direction, { leafId: LEAF_B, ratio })
    clearCallbacks()
  }

  // Mounting emits too; count only notifications caused by apply.
  function clearCallbacks(): void {
    onLayoutChanged.mockClear()
  }

  function serialized(): TerminalPaneLayoutNode | null {
    const top = root.firstElementChild
    return top instanceof HTMLElement ? serializePaneTree(top) : null
  }

  function paneIdentity(): unknown[] {
    return manager.getPanes().flatMap((pane) => [pane.id, pane.container, pane.terminal])
  }

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', () => 1)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    root = document.createElement('div')
    document.body.appendChild(root)
    onLayoutChanged = vi.fn()
    manager = new PaneManager(root, {
      linkOpenHint: () => '',
      onLayoutChanged
    })
  })

  afterEach(() => {
    manager.destroy()
    root.remove()
    vi.unstubAllGlobals()
  })

  it('flips orientation in place and swaps the divider to the new axis', () => {
    mountTwoPanes('vertical', 0.4)
    const before = paneIdentity()
    const split = root.firstElementChild
    const oldDivider = root.querySelector('.pane-divider')

    const applied = manager.applyLayoutGeometry({
      type: 'split',
      direction: 'horizontal',
      first: leaf(LEAF_A),
      second: leaf(LEAF_B),
      ratio: 0.4
    })

    expect(applied).toBe(true)
    expect(root.firstElementChild).toBe(split)
    expect(serialized()).toMatchObject({ direction: 'horizontal', ratio: 0.4 })
    const dividers = root.querySelectorAll('.pane-divider')
    expect(dividers).toHaveLength(1)
    expect(dividers[0]).not.toBe(oldDivider)
    expect(dividers[0].classList.contains('is-horizontal')).toBe(true)
    expect(paneIdentity()).toEqual(before)
    expect(onLayoutChanged).not.toHaveBeenCalled()
  })
})
