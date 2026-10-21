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
  let manager: InstanceType<typeof PaneManager>

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', () => 1)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    root = document.createElement('div')
    document.body.appendChild(root)
    onPaneCreated = vi.fn()
    manager = new PaneManager(root, { linkOpenHint: () => '', onPaneCreated })
  })

  afterEach(() => {
    manager.destroy()
    root.remove()
    vi.unstubAllGlobals()
  })

  it('marks a tab first pane as a new tab', () => {
    const pane = manager.createInitialPane({ leafId: LEAF_A })

    expect(onPaneCreated).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: pane.id, leafId: LEAF_A }),
      { placement: { kind: 'new-tab' } }
    )
  })

  it('names the split pane and direction alongside the other spawn hints', () => {
    const first = manager.createInitialPane({ leafId: LEAF_A })
    onPaneCreated.mockClear()

    manager.splitPane(first.id, 'horizontal', { leafId: LEAF_B, cwd: '/repo/app' })

    expect(onPaneCreated).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ leafId: LEAF_B }),
      {
        cwd: '/repo/app',
        placement: { kind: 'split', parentLeafId: LEAF_A, direction: 'horizontal' }
      }
    )
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
