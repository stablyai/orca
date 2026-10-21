// The main-process allowlist yields Emacs chords while an Emacs-preset editor has focus.
import { describe, expect, it } from 'vitest'
import { resolveWindowShortcutAction, type WindowShortcutInput } from './window-shortcut-policy'

const ctrlChord = (code: string, key: string): WindowShortcutInput => ({
  type: 'keyDown',
  code,
  key,
  control: true,
  meta: false,
  alt: false,
  shift: false
})

describe('resolveWindowShortcutAction in the editor context', () => {
  it.each(['linux', 'win32'] as const)('leaves Emacs chords to the editor on %s', (platform) => {
    const quickOpen = ctrlChord('KeyP', 'p')
    expect(resolveWindowShortcutAction(quickOpen, platform)).toEqual({ type: 'openQuickOpen' })
    expect(resolveWindowShortcutAction(quickOpen, platform, undefined, { context: 'app' })).toEqual(
      { type: 'openQuickOpen' }
    )
    expect(
      resolveWindowShortcutAction(quickOpen, platform, undefined, { context: 'editor' })
    ).toBeNull()
    for (const [code, key] of [
      ['KeyN', 'n'],
      ['KeyE', 'e'],
      ['KeyB', 'b'],
      ['KeyL', 'l']
    ] as const) {
      expect(
        resolveWindowShortcutAction(ctrlChord(code, key), platform, undefined, {
          context: 'editor'
        })
      ).toBeNull()
    }
  })

  it('still resolves chords the Emacs preset does not bind', () => {
    const options = { context: 'editor' as const }
    expect(
      resolveWindowShortcutAction(
        { ...ctrlChord('KeyJ', 'J'), shift: true },
        'linux',
        undefined,
        options
      )
    ).toEqual({ type: 'toggleWorktreePalette' })
    expect(
      resolveWindowShortcutAction(ctrlChord('Digit1', '1'), 'linux', undefined, options)
    ).toEqual({ type: 'jumpToWorktreeIndex', index: 0 })
    expect(
      resolveWindowShortcutAction(
        {
          type: 'keyDown',
          code: 'KeyP',
          key: 'p',
          meta: true,
          control: false,
          alt: false,
          shift: false
        },
        'darwin',
        undefined,
        options
      )
    ).toEqual({ type: 'openQuickOpen' })
  })
})
