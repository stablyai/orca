import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Terminal } from '@xterm/headless'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import type { IUnicodeVersionProvider } from '@xterm/xterm'
import { afterEach, expect, it, vi } from 'vitest'
import { activateOrcaTerminalUnicodeProvider } from './terminal-unicode-provider'

const terminals: Terminal[] = []
afterEach(() => {
  vi.unstubAllGlobals()
  terminals.splice(0).forEach((terminal) => terminal.dispose())
})

function provider(bun: boolean): IUnicodeVersionProvider {
  vi.stubGlobal('process', {
    ...process,
    versions: { ...process.versions, bun: bun ? '1.4.2' : undefined }
  })
  const terminal = new Terminal({ allowProposedApi: true })
  terminals.push(terminal)
  terminal.loadAddon(new Unicode11Addon())
  const unicode = terminal.unicode
  const register = vi.spyOn(unicode, 'register')
  const unicodeCore: {
    unicode: typeof unicode
    _core?: { unicodeService?: { _providers?: Record<string, IUnicodeVersionProvider> } }
  } = terminal
  activateOrcaTerminalUnicodeProvider({ unicode, _core: unicodeCore._core })
  const registered = register.mock.calls[0]?.[0]
  if (!registered) {
    throw new Error('Unicode provider was not registered')
  }
  return registered
}

it('preserves Unicode11 and ZWJ properties across the Bun ASCII specialization', () => {
  const original = provider(false)
  const optimized = provider(true)
  const preceding = new Set([0, 1, 2, 3, 4, 5])
  for (const codepoint of [0x200d, 0x301, 0x1f469, 0x1f4bb, 0xac00, 0xfe0f]) {
    // Snapshot the states because this loop extends the set.
    for (const state of Array.from(preceding)) {
      preceding.add(original.charProperties(codepoint, state))
    }
  }
  for (const state of preceding) {
    for (let codepoint = 0; codepoint <= 0xff; codepoint++) {
      expect(optimized.charProperties(codepoint, state)).toBe(
        original.charProperties(codepoint, state)
      )
    }
  }
  for (const text of ['a\u200db', '👩‍💻 ascii', '한글 abc', 'a\u0301b', '🏳️‍🌈 x']) {
    let originalState = 0
    let optimizedState = 0
    for (const char of text) {
      const codepoint = char.codePointAt(0)
      if (codepoint === undefined) {
        throw new Error('Missing codepoint')
      }
      originalState = original.charProperties(codepoint, originalState)
      optimizedState = optimized.charProperties(codepoint, optimizedState)
      expect(optimizedState).toBe(originalState)
    }
  }
})

it('pins the headless fast-path identity and ASCII invariant for both providers', () => {
  const source = readFileSync(
    join(__dirname, '../../config/patches/xterm-src/@xterm__headless@6.1.0-beta.302.src.patch'),
    'utf8'
  )
  const literal = /activeVersion === '([^']+)'/.exec(source)?.[1]
  expect(literal).toBeDefined()
  for (const bun of [false, true]) {
    const active = provider(bun)
    expect(active.version).toBe(literal)
    for (let codepoint = 0x20; codepoint < 0x7f; codepoint++) {
      expect(active.charProperties(codepoint, 2)).toBe(2)
    }
  }
})
