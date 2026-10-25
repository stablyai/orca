import { describe, expect, it } from 'vitest'
import { resolveWindowShortcutAction } from './window-shortcut-policy'

describe('New Window shortcut policy', () => {
  it('resolves the default and custom binding to the main-process action', () => {
    expect(
      resolveWindowShortcutAction(
        { code: 'KeyN', key: 'n', meta: true, control: false, alt: true, shift: false },
        'darwin'
      )
    ).toEqual({ type: 'newWindow' })

    expect(
      resolveWindowShortcutAction(
        { code: 'KeyN', key: 'n', meta: false, control: true, alt: true, shift: false },
        'linux'
      )
    ).toEqual({ type: 'newWindow' })

    expect(
      resolveWindowShortcutAction(
        { code: 'KeyW', key: 'w', meta: false, control: true, alt: true, shift: true },
        'win32',
        { 'window.new': ['Mod+Alt+Shift+W'] }
      )
    ).toEqual({ type: 'newWindow' })

    expect(
      resolveWindowShortcutAction(
        { code: 'KeyN', key: 'n', meta: false, control: true, alt: true, shift: false },
        'win32',
        { 'window.new': ['Mod+Alt+Shift+W'] }
      )
    ).toBeNull()
  })
})
