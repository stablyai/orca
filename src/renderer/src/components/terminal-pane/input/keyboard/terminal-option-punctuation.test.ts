import { describe, expect, it, vi } from 'vitest'
import { resolveTerminalOptionShortcutAction } from './terminal-option-shortcut-policy'
import { createTerminalOptionKittyReleaseTracker } from './terminal-option-kitty-release'

type OptionEvent = Parameters<typeof resolveTerminalOptionShortcutAction>[0]
type OptionContext = Parameters<typeof resolveTerminalOptionShortcutAction>[1]

const punctuation = [
  { code: 'Semicolon', key: '…', base: ';', codePoint: 59 },
  { code: 'Period', key: '≥', base: '.', codePoint: 46 },
  { code: 'Comma', key: '≤', base: ',', codePoint: 44 }
] as const

const altModes = [
  { macOptionAsAlt: 'true', optionKeyLocations: 0 },
  { macOptionAsAlt: 'left', optionKeyLocations: 1 },
  { macOptionAsAlt: 'right', optionKeyLocations: 2 }
] as const

function optionEvent(overrides: Partial<OptionEvent>): OptionEvent {
  return {
    key: '',
    code: '',
    altKey: true,
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    repeat: false,
    ...overrides
  }
}

function optionContext(overrides: Partial<OptionContext> = {}): OptionContext {
  return {
    isMac: true,
    macOptionAsAlt: 'true',
    optionKeyLocations: 0,
    getKittyKeyboardFlags: () => 1,
    ...overrides
  }
}

describe.each(punctuation)('Option+$base punctuation ($code)', ({ code, key, base, codePoint }) => {
  it('reports repeats and one release for the original punctuation key', () => {
    for (const mode of altModes) {
      const sendInput = vi.fn()
      const releases = createTerminalOptionKittyReleaseTracker()
      const context = optionContext({ ...mode, getKittyKeyboardFlags: () => 7 })
      for (const repeat of [false, true]) {
        const event = optionEvent({ code, key, repeat })
        const action = resolveTerminalOptionShortcutAction(event, context)
        expect(action).toEqual({
          type: 'sendInput',
          data: `\x1b[${codePoint};3${repeat ? ':2' : ''}u`,
          optionKittyRelease: { flags: 7 }
        })
        if (action?.type === 'sendInput' && action.optionKittyRelease) {
          sendInput(action.data)
          releases.arm(event, action.optionKittyRelease, sendInput, context.getKittyKeyboardFlags)
        }
      }
      const release = optionEvent({ code, key: base, altKey: false })
      expect(releases.settle(release)).toBe(true)
      expect(releases.settle(release)).toBe(false)
      expect(sendInput.mock.calls.map(([data]) => data)).toEqual([
        `\x1b[${codePoint};3u`,
        `\x1b[${codePoint};3:2u`,
        `\x1b[${codePoint};1:3u`
      ])
    }
  })
})
