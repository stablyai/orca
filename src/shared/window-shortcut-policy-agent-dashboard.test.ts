import { describe, expect, it } from 'vitest'
import { getWindowShortcutActionId, resolveWindowShortcutAction } from './window-shortcut-policy'

const input = {
  code: 'KeyD',
  key: 'd',
  meta: false,
  control: true,
  alt: true,
  shift: false
}

describe('agent dashboard toggle shortcut', () => {
  it('stays unbound until a user assigns a chord', () => {
    expect(resolveWindowShortcutAction(input, 'linux')).toBeNull()
  })

  it('resolves a custom binding to the dashboard toggle', () => {
    expect(
      resolveWindowShortcutAction(input, 'linux', { 'dashboard.toggle': ['Mod+Alt+D'] })
    ).toEqual({ type: 'toggleAgentDashboard' })
  })

  it('still resolves while a terminal owns focus under terminal-first', () => {
    // Why: the action sets allowInTerminal, and the premise of the feature is that
    // the chord reaches the dashboard even when a PTY would otherwise claim keys.
    expect(
      resolveWindowShortcutAction(
        input,
        'linux',
        { 'dashboard.toggle': ['Mod+Alt+D'] },
        { context: 'terminal', terminalShortcutPolicy: 'terminal-first' }
      )
    ).toEqual({ type: 'toggleAgentDashboard' })
  })

  it('maps the action back to its keybinding id', () => {
    expect(getWindowShortcutActionId({ type: 'toggleAgentDashboard' })).toBe('dashboard.toggle')
  })
})
