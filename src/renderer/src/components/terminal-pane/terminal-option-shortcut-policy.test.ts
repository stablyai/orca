import { describe, expect, it } from 'vitest'
import {
  resolveTerminalOptionShortcutAction,
  type MacOptionAsAlt
} from './terminal-option-shortcut-policy'

function optionEvent(
  key: string,
  code: string,
  macOptionAsAlt: MacOptionAsAlt = 'false',
  kittyFlags = 1
) {
  return resolveTerminalOptionShortcutAction(
    { key, code, metaKey: false, ctrlKey: false, altKey: true, shiftKey: false },
    {
      isMac: true,
      macOptionAsAlt,
      optionKeyLocations: 0,
      getKittyKeyboardFlags: () => kittyFlags
    }
  )
}

describe('resolveTerminalOptionShortcutAction Latin composition', () => {
  it.each([
    ['ç', 'KeyC'],
    ['ã', 'KeyA'],
    ['å', 'KeyA'],
    ['ą', 'KeyA'],
    ['ñ', 'KeyN'],
    ['ü', 'KeyU']
  ])('passes composed %s through as text in compose mode', (key, code) => {
    expect(optionEvent(key, code)).toEqual({ type: 'sendInput', data: key })
  })

  it.each([
    ['µ', 'KeyM', '\x1b[109;3u'],
    ['÷', 'Slash', '\x1b[47;3u'],
    ['π', 'KeyP', '\x1b[112;3u']
  ])('keeps hotkey encoding for %s', (key, code, data) => {
    expect(optionEvent(key, code)).toEqual({ type: 'sendInput', data })
  })

  it('encodes Latin letters when Option acts as Meta', () => {
    expect(optionEvent('ç', 'KeyC', 'true')).toEqual({ type: 'sendInput', data: '\x1b[99;3u' })
  })

  it('encodes when Option produced no composition', () => {
    expect(optionEvent('c', 'KeyC')).toEqual({ type: 'sendInput', data: '\x1b[99;3u' })
  })

  it('leaves composed letters to xterm when kitty is inactive', () => {
    expect(optionEvent('ç', 'KeyC', 'false', 0)).toBeNull()
  })
})
