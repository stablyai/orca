// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { PaneManagerOptions } from './pane-manager-types'
import { serializePaneTree } from '@/components/terminal-pane/layout-serialization'

// Why: happy-dom has no canvas, so xterm cannot open; placement never touches the terminal.
vi.mock('./pane-lifecycle', async (importOriginal) => {
  const actual: object = await importOriginal()
  return { ...actual, openTerminal: vi.fn() }
})

const { PaneManager } = await import('./pane-manager')

const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'
const LEAF_C = '33333333-3333-4333-8333-333333333333'

describe('PaneManager spawn placement hints', () => {
  let root: HTMLDivElement
  let onPaneCreated: Mock<NonNullable<PaneManagerOptions['onPaneCreated']>>
  let onActivePaneChange: Mock<NonNullable<PaneManagerOptions['onActivePaneChange']>>
  let manager: InstanceType<typeof PaneManager>

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', () => 1)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    root = document.createElement('div')
    document.body.appendChild(root)
    onPaneCreated = vi.fn()
    onActivePaneChange = vi.fn()
    manager = new PaneManager(root, { linkOpenHint: () => '', onPaneCreated, onActivePaneChange })
  })

  afterEach(() => {
    manager.destroy()
    root.remove()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('retains only the latest immutable explicit selection, including same-ID pointer selection, and clears it on destroy', () => {
    const pane = manager.createInitialPane({ focus: false, leafId: LEAF_A })
    const heading = document.createElement('h2')
    heading.dataset.panePreventTerminalFocus = ''
    pane.container.append(heading)
    const focus = vi.spyOn(pane.terminal, 'focus')
    expect(manager.getExplicitPaneSelection()).toBeNull()
    heading.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    const first = manager.getExplicitPaneSelection()
    expect(first).toEqual({ paneId: pane.id, leafId: pane.leafId })
    expect(Object.isFrozen(first)).toBe(true)
    heading.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    const latest = manager.getExplicitPaneSelection()
    expect(latest).toEqual(first)
    expect(latest).not.toBe(first)
    expect(focus).not.toHaveBeenCalled()
    expect(onActivePaneChange).not.toHaveBeenCalled()
    manager.setActivePane(pane.id, { focus: false })
    manager.setActivePane(-1, { explicitUserSelection: true })
    expect(manager.getExplicitPaneSelection()).toBe(latest)
    manager.destroy()
    expect(manager.getExplicitPaneSelection()).toBeNull()
  })

  it('records only accepted configured focus-follows-mouse selection before requesting focus', () => {
    const first = manager.createInitialPane({ focus: false, leafId: LEAF_A })
    const second = manager.splitPane(first.id, 'vertical', { leafId: LEAF_B })!
    manager.setActivePane(first.id, { focus: false })
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    second.container.dispatchEvent(new MouseEvent('mouseenter'))
    expect(manager.getExplicitPaneSelection()).toBeNull()
    manager.setPaneStyleOptions({ focusFollowsMouse: true })
    second.container.dispatchEvent(new MouseEvent('mouseenter', { buttons: 1 }))
    expect(manager.getExplicitPaneSelection()).toBeNull()
    vi.spyOn(second.terminal, 'focus').mockImplementation(() => {
      expect(manager.getExplicitPaneSelection()).toEqual({
        paneId: second.id,
        leafId: second.leafId
      })
    })
    second.container.dispatchEvent(new MouseEvent('mouseenter'))
    const receipt = manager.getExplicitPaneSelection()
    expect(receipt).toEqual({ paneId: second.id, leafId: second.leafId })
    expect(second.terminal.focus).toHaveBeenCalledOnce()
    manager.retirePanePreservingPty(second.id)
    expect(manager.getActivePane()?.id).toBe(first.id)
    expect(manager.getExplicitPaneSelection()).toBe(receipt)
  })

  it('publishes a split placed before a mounted subtree with its final order', () => {
    const first = manager.createInitialPane({ leafId: LEAF_A })
    manager.splitPane(first.id, 'vertical', { leafId: LEAF_B })
    const treesAtCreation: unknown[] = []
    onPaneCreated.mockReset().mockImplementation(() => {
      const top = root.firstElementChild
      treesAtCreation.push(top instanceof HTMLElement ? serializePaneTree(top) : null)
    })

    manager.splitPaneAroundLeafIds([LEAF_A, LEAF_B], first.id, 'horizontal', {
      leafId: LEAF_C,
      placement: 'before'
    })

    expect(onPaneCreated).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ leafId: LEAF_C }),
      { placement: { kind: 'split', parentLeafId: LEAF_A, direction: 'horizontal' } }
    )
    // The pane-created handler serializes proposedRoot from the DOM, so the order must be final then.
    expect(treesAtCreation).toEqual([
      {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', leafId: LEAF_C },
        second: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: LEAF_A },
          second: { type: 'leaf', leafId: LEAF_B }
        }
      }
    ])
  })
})
