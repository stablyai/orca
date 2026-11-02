// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({
  activeView: 'terminal',
  goBackWorktree: vi.fn(),
  goForwardWorktree: vi.fn()
}))

vi.mock('../../store', () => ({ useAppStore: { getState: () => store } }))

import { registerWorkspaceShortcutIpcBridge } from './workspace-shortcut-ipc-bridge'

describe('mouse side buttons over Orca UI', () => {
  let unsubs: (() => void)[]

  beforeEach(() => {
    store.activeView = 'terminal'
    store.goBackWorktree.mockReset()
    store.goForwardWorktree.mockReset()
    const ui = new Proxy({}, { get: () => () => () => {} })
    ;(window as unknown as { api: unknown }).api = { ui }
    unsubs = []
    registerWorkspaceShortcutIpcBridge(unsubs)
  })

  afterEach(() => {
    for (const unsub of unsubs) {
      unsub()
    }
  })

  function release(button: number): MouseEvent {
    const event = new MouseEvent('mouseup', { button, bubbles: true, cancelable: true })
    document.body.dispatchEvent(event)
    return event
  }

  it('steps worktree history back and forward and claims the press', () => {
    expect(release(3).defaultPrevented).toBe(true)
    expect(store.goBackWorktree).toHaveBeenCalledTimes(1)
    release(4)
    expect(store.goForwardWorktree).toHaveBeenCalledTimes(1)
  })

  it('ignores other buttons and views without the history arrows', () => {
    release(0)
    store.activeView = 'settings'
    release(3)
    expect(store.goBackWorktree).not.toHaveBeenCalled()
  })

  it('leaves a press already claimed by a streamed page alone', () => {
    const viewport = document.createElement('div')
    document.body.append(viewport)
    viewport.addEventListener('mouseup', (event) => event.preventDefault())
    viewport.dispatchEvent(
      new MouseEvent('mouseup', { button: 3, bubbles: true, cancelable: true })
    )
    viewport.remove()
    expect(store.goBackWorktree).not.toHaveBeenCalled()
  })
})
