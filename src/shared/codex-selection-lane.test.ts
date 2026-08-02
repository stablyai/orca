import { describe, expect, it } from 'vitest'
import {
  getCodexSelectionLaneKey,
  getWslSelectionKey,
  normalizeCodexAccountSelectionTarget
} from './codex-selection-lane'

describe('normalizeCodexAccountSelectionTarget', () => {
  it('defaults an absent target to the host lane', () => {
    expect(normalizeCodexAccountSelectionTarget(undefined)).toEqual({
      runtime: 'host',
      wslDistro: null
    })
    expect(normalizeCodexAccountSelectionTarget(null)).toEqual({ runtime: 'host', wslDistro: null })
  })

  it('defaults a target with no runtime to the host lane', () => {
    expect(normalizeCodexAccountSelectionTarget({})).toEqual({ runtime: 'host', wslDistro: null })
  })

  it('keeps an explicit host target on the host lane and ignores a wslDistro', () => {
    expect(normalizeCodexAccountSelectionTarget({ runtime: 'host', wslDistro: 'Ubuntu' })).toEqual({
      runtime: 'host',
      wslDistro: null
    })
  })

  it('routes a wsl target without a distro to the default wsl lane', () => {
    expect(normalizeCodexAccountSelectionTarget({ runtime: 'wsl' })).toEqual({
      runtime: 'wsl',
      wslDistro: null
    })
    expect(normalizeCodexAccountSelectionTarget({ runtime: 'wsl', wslDistro: null })).toEqual({
      runtime: 'wsl',
      wslDistro: null
    })
  })

  it('trims surrounding whitespace from a wsl distro', () => {
    expect(
      normalizeCodexAccountSelectionTarget({ runtime: 'wsl', wslDistro: '  Ubuntu  ' })
    ).toEqual({
      runtime: 'wsl',
      wslDistro: 'Ubuntu'
    })
  })

  it('treats a whitespace-only wsl distro as the default lane', () => {
    expect(normalizeCodexAccountSelectionTarget({ runtime: 'wsl', wslDistro: '   ' })).toEqual({
      runtime: 'wsl',
      wslDistro: null
    })
  })
})

describe('getCodexSelectionLaneKey', () => {
  it('keys a host target to "host"', () => {
    expect(getCodexSelectionLaneKey(undefined)).toBe('host')
    expect(getCodexSelectionLaneKey({ runtime: 'host' })).toBe('host')
  })

  it('keys a wsl target without a distro to the default wsl lane', () => {
    expect(getCodexSelectionLaneKey({ runtime: 'wsl' })).toBe('wsl:__default__')
    expect(getCodexSelectionLaneKey({ runtime: 'wsl', wslDistro: null })).toBe('wsl:__default__')
  })

  it('keys a wsl target with a distro to that distro lane, trimmed', () => {
    expect(getCodexSelectionLaneKey({ runtime: 'wsl', wslDistro: 'Ubuntu' })).toBe('wsl:Ubuntu')
    expect(getCodexSelectionLaneKey({ runtime: 'wsl', wslDistro: '  Debian  ' })).toBe('wsl:Debian')
  })

  it('keys a whitespace-only wsl distro to the default lane', () => {
    expect(getCodexSelectionLaneKey({ runtime: 'wsl', wslDistro: '   ' })).toBe('wsl:__default__')
  })
})

describe('getWslSelectionKey', () => {
  it('returns the default sentinel for an absent or empty distro', () => {
    expect(getWslSelectionKey(undefined)).toBe('__default__')
    expect(getWslSelectionKey(null)).toBe('__default__')
    expect(getWslSelectionKey('')).toBe('__default__')
    expect(getWslSelectionKey('   ')).toBe('__default__')
  })

  it('returns a non-empty distro, trimmed', () => {
    expect(getWslSelectionKey('Ubuntu')).toBe('Ubuntu')
    expect(getWslSelectionKey('  Ubuntu  ')).toBe('Ubuntu')
  })

  it('preserves internal whitespace (only surrounding whitespace is trimmed)', () => {
    expect(getWslSelectionKey('Ubuntu 22.04')).toBe('Ubuntu 22.04')
    expect(getCodexSelectionLaneKey({ runtime: 'wsl', wslDistro: 'Ubuntu 22.04' })).toBe(
      'wsl:Ubuntu 22.04'
    )
  })
})
