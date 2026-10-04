// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { focusRuntimeTerminalSurface, registerRuntimeTerminalTab } from './sync-runtime-graph'

let unregister: (() => void) | undefined

afterEach(() => {
  unregister?.()
  document.body.replaceChildren()
})

describe('terminal focus readiness', () => {
  function register(hasPane: boolean, hasTextarea = true) {
    const textarea = document.createElement('textarea')
    const pane = {
      id: 1,
      container: document.createElement('div'),
      terminal: {
        textarea: hasTextarea ? textarea : undefined,
        focus: vi.fn(() => textarea.focus())
      }
    }
    const manager = {
      getActivePane: () => (hasPane ? pane : undefined),
      getPanes: () => (hasPane ? [pane] : [])
    }
    unregister = registerRuntimeTerminalTab({
      tabId: 'restoring-tab',
      worktreeId: 'restoring-workspace',
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Focus reads only getActivePane/getPanes and the pane's container/terminal.
      getManager: () => manager as unknown as PaneManager,
      getContainer: () => null,
      getPtyIdForPane: () => null,
      getTabWideAgentHintLeafId: () => null
    })
    return textarea
  }

  it('does not report success before the active pane exists', () => {
    register(false)
    expect(focusRuntimeTerminalSurface('restoring-tab', null, 'restoring-workspace')).toBe(false)
  })

  it('does not report success before the terminal textarea exists', () => {
    register(true, false)
    expect(focusRuntimeTerminalSurface('restoring-tab', null, 'restoring-workspace')).toBe(false)
  })

  it('does not consume focus until the terminal can receive it', () => {
    const textarea = register(true)
    expect(focusRuntimeTerminalSurface('restoring-tab', null, 'restoring-workspace')).toBe(false)
    document.body.append(textarea)
    expect(focusRuntimeTerminalSurface('restoring-tab', null, 'restoring-workspace')).toBe(true)
    expect(document.activeElement).toBe(textarea)
  })
})
