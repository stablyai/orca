// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dispatchWorkspaceTabCommand } from './workspace-tab-commands'

const mocks = vi.hoisted(() => ({
  state: { activeView: 'terminal' },
  focusGroup: vi.fn(() => true),
  floatingFocused: false
}))

vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('@/hooks/ipc-tab-group-focus', () => ({ handleFocusTabGroup: mocks.focusGroup }))
vi.mock('./floating-workspace-terminal-actions', () => ({
  isFloatingWorkspacePanelFocused: () => mocks.floatingFocused,
  switchFloatingWorkspaceTab: vi.fn()
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.state.activeView = 'terminal'
  mocks.floatingFocused = false
})
afterEach(() => document.body.replaceChildren())

describe('split-group command workspace visibility', () => {
  it.each(['tasks', 'settings', 'dashboard'])(
    'keeps the visible %s view focused instead of activating a hidden group',
    (activeView) => {
      mocks.state.activeView = activeView
      const input = document.createElement('input')
      document.body.append(input)
      input.focus()

      expect(dispatchWorkspaceTabCommand({ type: 'focus-group', direction: 1 })).toBe(false)
      expect(mocks.focusGroup).not.toHaveBeenCalled()
      expect(document.activeElement).toBe(input)
    }
  )

  it('forwards the browser source and direction in the workspace view', () => {
    expect(
      dispatchWorkspaceTabCommand({
        type: 'focus-group',
        direction: -1,
        sourcePageId: 'source-page'
      })
    ).toBe(true)
    expect(mocks.focusGroup).toHaveBeenCalledWith(-1, 'source-page')
  })

  it('leaves floating-panel navigation untouched', () => {
    mocks.floatingFocused = true
    expect(dispatchWorkspaceTabCommand({ type: 'focus-group', direction: 1 })).toBe(false)
    expect(mocks.focusGroup).not.toHaveBeenCalled()
  })
})
