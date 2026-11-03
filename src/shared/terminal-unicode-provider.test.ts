import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  activateOrcaTerminalUnicodeProvider,
  setTerminalEastAsianAmbiguousWidthMode
} from './terminal-unicode-provider'

afterEach(() => {
  setTerminalEastAsianAmbiguousWidthMode('narrow')
})

function makeUnicodeHarness(baseWcwidth: (cp: number) => 0 | 1 | 2) {
  const baseProvider = {
    version: '11',
    wcwidth: baseWcwidth,
    charProperties: (codepoint: number, _preceding: number) => {
      const width = baseWcwidth(codepoint)
      return ((codepoint & 0xffffff) << 3) | ((width & 3) << 1)
    }
  }
  const providers: Record<string, typeof baseProvider> = {
    '11': baseProvider
  }
  const registered: { version: string; wcwidth: (cp: number) => 0 | 1 | 2 }[] = []
  const unicode = {
    activeVersion: '11',
    versions: ['11'] as string[],
    register(provider: { version: string; wcwidth: (cp: number) => 0 | 1 | 2 }) {
      registered.push(provider)
      providers[provider.version] = provider as typeof baseProvider
      this.versions.push(provider.version)
    }
  }
  const terminal = {
    unicode,
    _core: { unicodeService: { _providers: providers } }
  }
  return { terminal, registered, providers }
}

describe('activateOrcaTerminalUnicodeProvider ambiguous width', () => {
  it('widens East Asian Ambiguous cells only in wide mode', () => {
    const baseWcwidth = (cp: number): 0 | 1 | 2 => {
      if (cp === 0x6f22) {
        return 2
      }
      if (cp === 0) {
        return 0
      }
      return 1
    }
    const { terminal, registered } = makeUnicodeHarness(baseWcwidth)
    activateOrcaTerminalUnicodeProvider(terminal)

    const provider = registered[0]!
    expect(provider.wcwidth(0x2460)).toBe(1)

    setTerminalEastAsianAmbiguousWidthMode('wide')
    expect(provider.wcwidth(0x2460)).toBe(2) // ①
    expect(provider.wcwidth(0x2605)).toBe(2) // ★
    expect(provider.wcwidth(0x0041)).toBe(1) // A
    expect(provider.wcwidth(0x6f22)).toBe(2) // 漢 stays wide
  })

  it('is a no-op when already active', () => {
    const { terminal, registered } = makeUnicodeHarness(() => 1)
    activateOrcaTerminalUnicodeProvider(terminal)
    const registerSpy = vi.fn()
    terminal.unicode.register = registerSpy
    activateOrcaTerminalUnicodeProvider(terminal)
    expect(registerSpy).not.toHaveBeenCalled()
    expect(registered).toHaveLength(1)
  })
})
