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

const composeModes = [
  { macOptionAsAlt: 'false', optionKeyLocations: 0 },
  { macOptionAsAlt: 'left', optionKeyLocations: 2 },
  { macOptionAsAlt: 'right', optionKeyLocations: 1 }
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
  it.each([1, 7])('reports the configured Alt side under keyboard flags %i', (flags) => {
    for (const mode of altModes) {
      expect(
        resolveTerminalOptionShortcutAction(
          optionEvent({ code, key }),
          optionContext({ ...mode, getKittyKeyboardFlags: () => flags })
        )
      ).toEqual({
        type: 'sendInput',
        data: `\x1b[${codePoint};3u`,
        optionKittyRelease: flags === 7 ? { flags } : undefined
      })
    }
  })

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

  it.each([1, 7])('preserves the composed symbol on the text side under flags %i', (flags) => {
    for (const mode of composeModes) {
      expect(
        resolveTerminalOptionShortcutAction(
          optionEvent({ code, key }),
          optionContext({ ...mode, getKittyKeyboardFlags: () => flags })
        )
      ).toEqual({
        type: 'sendInput',
        data: key,
        optionKittyRelease: flags === 7 ? { flags } : undefined
      })
    }
  })

  it('uses legacy escape bytes for a selected Alt side in an ordinary shell', () => {
    for (const mode of altModes.slice(1)) {
      expect(
        resolveTerminalOptionShortcutAction(
          optionEvent({ code, key }),
          optionContext({ ...mode, getKittyKeyboardFlags: () => 0 })
        )
      ).toEqual({ type: 'sendInput', data: `\x1b${base}` })
    }
    for (const mode of [altModes[0], ...composeModes]) {
      expect(
        resolveTerminalOptionShortcutAction(
          optionEvent({ code, key }),
          optionContext({ ...mode, getKittyKeyboardFlags: () => 0 })
        )
      ).toBeNull()
    }
  })

  it.each([{ isComposing: true }, { keyCode: 229 }, { key: 'Process' }, { key: 'Unidentified' }])(
    'leaves IME-owned punctuation to native input (%j)',
    (imeState) => {
      for (const mode of [...altModes, ...composeModes]) {
        expect(
          resolveTerminalOptionShortcutAction(
            optionEvent({ code, key, ...imeState }),
            optionContext({ ...mode, getKittyKeyboardFlags: () => 7 })
          )
        ).toBeNull()
      }
    }
  )

  it('leaves non-Mac input and additional command modifiers untouched', () => {
    for (const overrides of [{ isMac: false }, { isMac: true }]) {
      const context = optionContext(overrides)
      const events =
        overrides.isMac === false
          ? [optionEvent({ code, key })]
          : [optionEvent({ code, key, ctrlKey: true }), optionEvent({ code, key, metaKey: true })]
      for (const event of events) {
        expect(resolveTerminalOptionShortcutAction(event, context)).toBeNull()
      }
    }
  })
})

it('uses the active layout character rather than the US punctuation position', () => {
  const event = optionEvent({ code: 'Semicolon', key: 'µ' })
  const layout = (code: string): string | undefined => (code === 'Semicolon' ? 'm' : undefined)
  for (const mode of altModes) {
    expect(
      resolveTerminalOptionShortcutAction(
        event,
        optionContext({ ...mode, layoutCharacterForCode: layout, getKittyKeyboardFlags: () => 7 })
      )
    ).toEqual({
      type: 'sendInput',
      data: '\x1b[109::59;3u',
      optionKittyRelease: { flags: 7 }
    })
  }
  for (const mode of altModes.slice(1)) {
    expect(
      resolveTerminalOptionShortcutAction(
        event,
        optionContext({ ...mode, layoutCharacterForCode: layout, getKittyKeyboardFlags: () => 0 })
      )
    ).toEqual({ type: 'sendInput', data: '\x1bm' })
  }
})
