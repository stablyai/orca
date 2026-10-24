// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KeybindingOverrides } from '../../../../shared/keybindings'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import { worktree } from './worktree-list-groups-test-fixtures'
import { WorkspaceShortcutHint, WorkspaceShortcutHints } from './WorkspaceShortcutHints'

const state = vi.hoisted(() => {
  const keybindings: KeybindingOverrides = {}
  return { keybindings, activeModal: 'none', activeView: 'terminal' }
})
vi.mock('@/store', () => ({
  useAppStore: (selector: (value: typeof state) => unknown) => selector(state)
}))
vi.mock('@/lib/floating-workspace-terminal-actions', () => ({
  isFloatingWorkspacePanelFocused: () =>
    Boolean(document.activeElement?.closest('[data-floating-terminal-panel]'))
}))

const local = { ...worktree, hostId: 'local' as const }
const remote = { ...worktree, hostId: 'ssh:build' as const }

function fixture(identities = [local, remote].map(getWorktreeHostIdentity)) {
  return (
    <WorkspaceShortcutHints workspaceIdentities={identities}>
      <div data-testid="local">
        <WorkspaceShortcutHint worktree={local} />
      </div>
      <div data-testid="remote">
        <WorkspaceShortcutHint worktree={remote} />
      </div>
    </WorkspaceShortcutHints>
  )
}

function key(type: 'keydown' | 'keyup', init: KeyboardEventInit): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent(type, init))
  })
}

function hold(init: KeyboardEventInit = { key: 'Meta', metaKey: true }): void {
  key('keydown', init)
  act(() => {
    vi.advanceTimersByTime(250)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mac')
  state.keybindings = {}
  state.activeModal = 'none'
  state.activeView = 'terminal'
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('workspace shortcut hints', () => {
  it('reveals the numbered targets after holding Command, without claiming the key', () => {
    const view = render(fixture())
    const event = new KeyboardEvent('keydown', { key: 'Meta', metaKey: true, cancelable: true })
    act(() => {
      window.dispatchEvent(event)
    })
    act(() => {
      vi.advanceTimersByTime(249)
    })
    expect(view.getByTestId('local').textContent).toBe('')
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(view.getByTestId('local').textContent).toBe('1')
    expect(view.getByTestId('remote').textContent).toBe('2')
    expect(event.defaultPrevented).toBe(false)
    key('keyup', { key: 'Meta' })
    expect(view.getByTestId('local').textContent).toBe('')
  })

  it('uses sidebar order and keeps same-path workspaces on different hosts distinct', () => {
    const view = render(fixture())
    hold()
    view.rerender(fixture([remote, local].map(getWorktreeHostIdentity)))
    expect(view.getByTestId('local').textContent).toBe('2')
    expect(view.getByTestId('remote').textContent).toBe('1')
    view.rerender(fixture([getWorktreeHostIdentity(remote)]))
    expect(view.getByTestId('local').textContent).toBe('')
    expect(view.getByTestId('remote').textContent).toBe('1')
  })

  it('does not number a tenth workspace', () => {
    const view = render(
      fixture([
        ...Array.from({ length: 9 }, (_, i) => `workspace-${i}`),
        getWorktreeHostIdentity(local)
      ])
    )
    hold()
    expect(view.getByTestId('local').textContent).toBe('')
  })

  it.each(['Linux', 'Windows'])('uses Control on %s', (platform) => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(platform)
    const view = render(fixture())
    hold()
    expect(view.getByTestId('local').textContent).toBe('')
    hold({ key: 'Control', ctrlKey: true })
    expect(view.getByTestId('local').textContent).toBe('1')
  })

  it('follows remapped modifiers and hides for extra modifiers', () => {
    state.keybindings = { 'workspace.selectByIndex': ['Ctrl+Shift+1'] }
    const view = render(fixture())
    hold()
    expect(view.getByTestId('local').textContent).toBe('')
    hold({ key: 'Shift', ctrlKey: true, shiftKey: true })
    expect(view.getByTestId('local').textContent).toBe('1')
    key('keydown', { key: 'Alt', ctrlKey: true, shiftKey: true, altKey: true })
    expect(view.getByTestId('local').textContent).toBe('')
  })

  it('hides when the shortcut is unassigned', () => {
    state.keybindings = { 'workspace.selectByIndex': [] }
    const view = render(fixture())
    hold()
    expect(view.getByTestId('local').textContent).toBe('')
  })

  it.each(['blur', 'visibilitychange'])('clears pending and visible hints on %s', (type) => {
    const view = render(fixture())
    key('keydown', { key: 'Meta', metaKey: true })
    const target = type === 'blur' ? window : document
    act(() => {
      target.dispatchEvent(new Event(type))
      vi.advanceTimersByTime(300)
    })
    expect(view.getByTestId('local').textContent).toBe('')
    hold()
    expect(view.getByTestId('local').textContent).toBe('1')
    act(() => {
      target.dispatchEvent(new Event(type))
    })
    expect(view.getByTestId('local').textContent).toBe('')
  })

  it('does not flash on a quick Command chord or composing input', () => {
    const view = render(fixture())
    key('keydown', { key: 'Meta', metaKey: true })
    key('keyup', { key: 'Meta' })
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(view.getByTestId('local').textContent).toBe('')
    hold({ key: 'Meta', metaKey: true, isComposing: true })
    expect(view.getByTestId('local').textContent).toBe('')
  })

  it('does not advertise workspace shortcuts in the jump palette or settings', () => {
    const view = render(fixture())
    hold()
    state.activeModal = 'worktree-palette'
    view.rerender(fixture())
    expect(view.getByTestId('local').textContent).toBe('')
    state.activeModal = 'none'
    state.activeView = 'settings'
    view.rerender(fixture())
    expect(view.getByTestId('local').textContent).toBe('')
  })

  it('does not number board cards outside the sidebar provider', () => {
    const view = render(<WorkspaceShortcutHint worktree={local} />)
    hold()
    expect(view.container.textContent).toBe('')
  })
})
