// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => {
  const state: { activeView: string; activeModal: string | null } = {
    activeView: 'terminal',
    activeModal: null
  }
  return { ...state, goBackWorktree: vi.fn(), goForwardWorktree: vi.fn() }
})

vi.mock('../../store/index', () => ({ useAppStore: { getState: () => store } }))

import { registerWorkspaceShortcutIpcBridge } from './workspace-shortcut-ipc-bridge'

describe('mouse side buttons over Orca UI', () => {
  let unsubs: (() => void)[]

  beforeEach(() => {
    store.activeView = 'terminal'
    store.activeModal = null
    store.goBackWorktree.mockReset()
    store.goForwardWorktree.mockReset()
    // Every window.api.ui.onX registrar returns an unsubscribe.
    const ui = new Proxy({}, { get: () => () => () => {} })
    vi.stubGlobal('api', { ui })
    unsubs = []
    registerWorkspaceShortcutIpcBridge(unsubs)
  })

  afterEach(() => {
    for (const unsub of unsubs) {
      unsub()
    }
  })

  function release(button: number, target: EventTarget = document.body): MouseEvent {
    const event = new MouseEvent('mouseup', { button, bubbles: true, cancelable: true })
    target.dispatchEvent(event)
    return event
  }

  it('step workspace history one entry per press and claim it', () => {
    expect(release(3).defaultPrevented).toBe(true)
    expect(store.goBackWorktree).toHaveBeenCalledTimes(1)
    expect(release(4).defaultPrevented).toBe(true)
    expect(store.goForwardWorktree).toHaveBeenCalledTimes(1)
  })

  it('work on every view that shows the title-bar arrows', () => {
    store.activeView = 'tasks'
    release(3)
    expect(store.goBackWorktree).toHaveBeenCalledTimes(1)
  })

  it('leave the press alone on views without the arrows', () => {
    store.activeView = 'settings'
    expect(release(3).defaultPrevented).toBe(false)
    expect(store.goBackWorktree).not.toHaveBeenCalled()
  })

  it('ignore the other mouse buttons', () => {
    expect(release(0).defaultPrevented).toBe(false)
    release(2)
    expect(store.goBackWorktree).not.toHaveBeenCalled()
    expect(store.goForwardWorktree).not.toHaveBeenCalled()
  })

  it('leave a press a browser surface already claimed', () => {
    const toolbar = document.createElement('div')
    document.body.append(toolbar)
    toolbar.addEventListener('mouseup', (event) => event.preventDefault())
    release(3, toolbar)
    toolbar.remove()
    expect(store.goBackWorktree).not.toHaveBeenCalled()
  })
})
