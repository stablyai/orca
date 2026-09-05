import { describe, expect, it } from 'vitest'
import {
  selectActiveTerminalPaneKey,
  type ActiveTerminalPaneKeyState
} from './active-terminal-pane-key'

const LEAF = '0f7c1b2e-3d4a-4c5b-8e6f-7a8b9c0d1e2f'

function state(overrides: Partial<Record<keyof ActiveTerminalPaneKeyState, unknown>> = {}) {
  return {
    activeTabType: 'terminal',
    activeTabId: 'tab-1',
    terminalLayoutsByTabId: { 'tab-1': { activeLeafId: LEAF } },
    ...overrides
  } as unknown as ActiveTerminalPaneKeyState
}

describe('selectActiveTerminalPaneKey', () => {
  it('joins the active tab and its focused terminal leaf', () => {
    expect(selectActiveTerminalPaneKey(state())).toBe(`tab-1:${LEAF}`)
  })

  it('returns null without a focused terminal leaf', () => {
    expect(selectActiveTerminalPaneKey(state({ activeTabType: 'browser' }))).toBe(null)
    expect(selectActiveTerminalPaneKey(state({ activeTabId: null }))).toBe(null)
    expect(selectActiveTerminalPaneKey(state({ terminalLayoutsByTabId: {} }))).toBe(null)
    expect(
      selectActiveTerminalPaneKey(
        state({ terminalLayoutsByTabId: { 'tab-1': { activeLeafId: 'legacy-3' } } })
      )
    ).toBe(null)
  })
})
