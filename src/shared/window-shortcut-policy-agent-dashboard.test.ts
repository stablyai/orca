import { describe, expect, it } from 'vitest'
import { resolveWindowShortcutAction } from './window-shortcut-policy'

const input = {
  code: 'KeyD',
  key: 'd',
  meta: false,
  control: true,
  alt: true,
  shift: false
}

describe('agent dashboard toggle shortcut', () => {
  it('resolves a custom binding to the dashboard toggle', () => {
    expect(
      resolveWindowShortcutAction(input, 'linux', { 'dashboard.toggle': ['Mod+Alt+D'] })
    ).toEqual({ type: 'toggleAgentDashboard' })
  })

  it('still resolves while a terminal owns focus under terminal-first', () => {
    // allowInTerminal must deliver the dashboard chord even while the PTY owns input.
    expect(
      resolveWindowShortcutAction(
        input,
        'linux',
        { 'dashboard.toggle': ['Mod+Alt+D'] },
        { context: 'terminal', terminalShortcutPolicy: 'terminal-first' }
      )
    ).toEqual({ type: 'toggleAgentDashboard' })
  })
})
