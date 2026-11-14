// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/xterm'

// Why: happy-dom has no canvas, so xterm cannot open; focus is what this checks.
vi.mock('./pane-lifecycle', async (importOriginal) => {
  const actual: object = await importOriginal()
  return { ...actual, openTerminal: vi.fn() }
})

const { PaneManager } = await import('./pane-manager')

const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'

describe('PaneManager split focus', () => {
  let root: HTMLDivElement
  let manager: InstanceType<typeof PaneManager>

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', () => 1)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    root = document.createElement('div')
    document.body.appendChild(root)
    manager = new PaneManager(root, { linkOpenHint: () => '' })
  })

  afterEach(() => {
    manager.destroy()
    root.remove()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('leaves the active pane and keyboard focus alone for a split that must not activate', () => {
    const source = manager.createInitialPane({ leafId: LEAF_A, focus: false })
    // Stands in for xterm's input, which the split reparents along with its pane.
    const input = source.container.appendChild(document.createElement('textarea'))
    input.focus()
    const focus = vi.spyOn(Terminal.prototype, 'focus')

    const created = manager.splitPane(source.id, 'vertical', { leafId: LEAF_B, activate: false })

    expect(created?.leafId).toBe(LEAF_B)
    expect(manager.getActivePane()?.leafId).toBe(LEAF_A)
    expect(focus).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(input)
  })
})
