// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

// Why: happy-dom has no canvas, so xterm cannot open; the detach never draws the terminal.
vi.mock('./pane-lifecycle', async (importOriginal) => {
  const actual: object = await importOriginal()
  return { ...actual, openTerminal: vi.fn() }
})

const { PaneManager } = await import('./pane-manager')

describe('a pane moved out to another tab', () => {
  let root: HTMLDivElement
  let manager: InstanceType<typeof PaneManager>
  let staying: ReturnType<InstanceType<typeof PaneManager>['createInitialPane']>
  let moving: ReturnType<InstanceType<typeof PaneManager>['createInitialPane']>
  let focusStaying: Mock<() => void>

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', () => 1)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    root = document.createElement('div')
    document.body.appendChild(root)
    manager = new PaneManager(root, { linkOpenHint: () => '' })
    staying = manager.createInitialPane()
    moving = manager.splitPane(staying.id, 'vertical')!
    manager.setActivePane(moving.id)
    focusStaying = vi.fn<() => void>()
    staying.terminal.focus = focusStaying
  })

  afterEach(() => {
    manager.destroy()
    root.remove()
    document.body.replaceChildren()
    vi.unstubAllGlobals()
  })

  it('leaves focus where the user put it when the moved pane did not hold it', () => {
    // The user is typing in an editor in another group while the move lands.
    const editor = document.createElement('textarea')
    document.body.appendChild(editor)
    editor.focus()

    expect(manager.detachPaneForExternalMove(moving.id)).toBe(true)

    expect(focusStaying).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(editor)
  })

  it('hands focus to the sibling when the moved pane held it', () => {
    const input = document.createElement('textarea')
    moving.container.appendChild(input)
    input.focus()

    expect(manager.detachPaneForExternalMove(moving.id)).toBe(true)

    expect(focusStaying).toHaveBeenCalledTimes(1)
  })
})
