import { describe, expect, it } from 'vitest'
import { resolveWindowShortcutAction } from './window-shortcut-policy'

const enter = {
  type: 'keyDown',
  code: 'Enter',
  key: 'Enter',
  alt: true,
  shift: false
}

describe('open latest notification shortcut', () => {
  it('defaults to Cmd+Option+Enter on macOS', () => {
    expect(resolveWindowShortcutAction({ ...enter, meta: true, control: false }, 'darwin')).toEqual(
      { type: 'openLatestNotification' }
    )
  })

  it.each(['linux', 'win32'] as const)('defaults to Ctrl+Alt+Enter on %s', (platform) => {
    expect(resolveWindowShortcutAction({ ...enter, meta: false, control: true }, platform)).toEqual(
      { type: 'openLatestNotification' }
    )
  })

  it('still resolves while a terminal owns focus under terminal-first', () => {
    expect(
      resolveWindowShortcutAction({ ...enter, meta: true, control: false }, 'darwin', undefined, {
        context: 'terminal',
        terminalShortcutPolicy: 'terminal-first'
      })
    ).toEqual({ type: 'openLatestNotification' })
  })

  it('stops resolving once the user unbinds it', () => {
    expect(
      resolveWindowShortcutAction({ ...enter, meta: true, control: false }, 'darwin', {
        'notifications.openLatest': []
      })
    ).toBeNull()
  })
})
