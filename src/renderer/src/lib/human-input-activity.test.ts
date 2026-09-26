import { describe, expect, it } from 'vitest'
import {
  createHumanInputActivityTracker,
  type HumanInputActivityKind,
  type HumanInputScope
} from './human-input-activity'

type Listener = (event: { type: string; isTrusted: boolean; target: unknown }) => void

function fakeWindow() {
  const listeners = new Map<string, Set<Listener>>()
  const target = {
    addEventListener: (type: string, listener: Listener) => {
      const set = listeners.get(type) ?? new Set<Listener>()
      set.add(listener)
      listeners.set(type, set)
    },
    removeEventListener: (type: string, listener: Listener) => {
      listeners.get(type)?.delete(listener)
    }
  }
  const dispatch = (type: string, init: { isTrusted?: boolean; target?: unknown } = {}): void => {
    for (const listener of listeners.get(type) ?? []) {
      listener({ type, isTrusted: init.isTrusted ?? true, target: init.target ?? target })
    }
  }
  const listenerCount = (): number =>
    [...listeners.values()].reduce((total, set) => total + set.size, 0)
  return { target, dispatch, listenerCount }
}

function setup(initiallyFocused = true) {
  const win = fakeWindow()
  let now = 1_000
  let scope: HumanInputScope = { workspaceKey: 'wt-a', paneKey: 'tab-1:leaf-1' }
  const events: HumanInputActivityKind[] = []
  const tracker = createHumanInputActivityTracker({
    target: win.target,
    initiallyFocused,
    scope: () => scope,
    now: () => now
  })
  tracker.subscribe((kind) => events.push(kind))
  return {
    win,
    tracker,
    events,
    advance: (ms: number) => {
      now += ms
    },
    setNow: (value: number) => {
      now = value
    },
    setScope: (next: HumanInputScope) => {
      scope = next
    }
  }
}

describe('createHumanInputActivityTracker', () => {
  it('ignores untrusted synthetic input', () => {
    const { win, tracker, events } = setup()
    win.dispatch('keydown', { isTrusted: false })
    win.dispatch('pointerdown', { isTrusted: false })
    win.dispatch('wheel', { isTrusted: false })
    expect(events).toEqual([])
    expect(tracker.inputFor('wt-a', 'wt-b')).toEqual({
      msSinceHumanInput: null,
      msSinceHumanFocus: null,
      msSinceHumanInputByPaneKey: {}
    })
  })

  it('stamps input per workspace and per focused pane', () => {
    const { win, tracker, events, advance, setScope } = setup()
    win.dispatch('keydown')
    advance(500)
    setScope({ workspaceKey: 'wt-a', paneKey: 'tab-1:leaf-2' })
    win.dispatch('pointerdown')
    advance(250)
    setScope({ workspaceKey: 'wt-b', paneKey: 'tab-9:leaf-9' })
    win.dispatch('wheel')
    advance(100)

    expect(events).toEqual(['input', 'input', 'input'])
    expect(tracker.inputFor('wt-a', 'wt-b')).toEqual({
      msSinceHumanInput: 350,
      msSinceHumanFocus: 350,
      msSinceHumanInputByPaneKey: { 'tab-1:leaf-1': 850, 'tab-1:leaf-2': 350 }
    })
    expect(tracker.inputFor('wt-b', 'wt-b')).toEqual({
      msSinceHumanInput: 100,
      msSinceHumanFocus: 0,
      msSinceHumanInputByPaneKey: { 'tab-9:leaf-9': 100 }
    })
  })

  it('tracks window blur and focus, ignoring element focus changes', () => {
    const { win, tracker, events, advance } = setup()
    win.dispatch('blur', { target: { tagName: 'INPUT' } })
    expect(tracker.windowFocused()).toBe(true)
    expect(events).toEqual([])

    advance(1_000)
    win.dispatch('blur')
    expect(tracker.windowFocused()).toBe(false)
    advance(4_000)
    expect(tracker.inputFor('wt-a', 'wt-a').msSinceHumanFocus).toBe(4_000)

    win.dispatch('focus')
    expect(tracker.windowFocused()).toBe(true)
    expect(tracker.inputFor('wt-a', 'wt-a').msSinceHumanFocus).toBe(0)
    expect(events).toEqual(['focus', 'focus'])
  })

  it('stamps the workspace a focused window leaves', () => {
    const { tracker, advance } = setup()
    tracker.noteWorkspaceLeft('wt-a')
    advance(3_000)
    expect(tracker.inputFor('wt-a', 'wt-b').msSinceHumanFocus).toBe(3_000)
  })

  it('keeps ages monotonic when the clock steps backwards', () => {
    const { win, tracker, setNow } = setup()
    setNow(5_000)
    win.dispatch('keydown')
    setNow(2_000)
    expect(tracker.inputFor('wt-a', 'wt-b').msSinceHumanInput).toBe(0)
    setNow(5_700)
    expect(tracker.inputFor('wt-a', 'wt-b').msSinceHumanInput).toBe(700)
  })

  it('removes every listener on dispose', () => {
    const { win, tracker } = setup()
    expect(win.listenerCount()).toBe(5)
    tracker.dispose()
    expect(win.listenerCount()).toBe(0)
  })
})
