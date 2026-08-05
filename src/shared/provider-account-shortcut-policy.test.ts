import { describe, expect, it } from 'vitest'
import { resolveWindowShortcutAction } from './window-shortcut-policy'

describe('resolveAccountShortcut (via resolveWindowShortcutAction)', () => {
  it('resolves the Claude account digit range by default and leaves Codex unbound', () => {
    expect(
      resolveWindowShortcutAction(
        { code: 'Digit2', key: '2', meta: true, control: false, alt: true, shift: false },
        'darwin'
      )
    ).toEqual({ type: 'switchProviderAccountIndex', provider: 'claude', index: 1 })

    expect(
      resolveWindowShortcutAction(
        { code: 'Digit2', key: '2', meta: false, control: true, alt: true, shift: false },
        'linux'
      )
    ).toEqual({ type: 'switchProviderAccountIndex', provider: 'claude', index: 1 })

    // Codex has no default chord — the same digit range must not resolve until remapped.
    expect(
      resolveWindowShortcutAction(
        { code: 'Digit2', key: '2', meta: false, control: false, alt: false, shift: false },
        'darwin'
      )
    ).toBeNull()

    expect(
      resolveWindowShortcutAction(
        { code: 'Digit5', key: '5', meta: true, control: false, alt: true, shift: true },
        'darwin',
        { 'accounts.codex.selectByIndex': ['Mod+Alt+Shift+1'] }
      )
    ).toEqual({ type: 'switchProviderAccountIndex', provider: 'codex', index: 4 })
  })
})
