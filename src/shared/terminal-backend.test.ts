import { describe, expect, it } from 'vitest'
import {
  normalizeHerdrRuntimeSource,
  normalizeHerdrSessionName,
  planTerminalBackendChange,
  resolveDesiredTerminalBackend,
  resolveTerminalBackend
} from './terminal-backend'

describe('resolveTerminalBackend', () => {
  it('keeps an existing project on its activated backend when the global default changes', () => {
    expect(
      resolveTerminalBackend({
        globalDefault: 'herdr',
        preference: 'inherit',
        activation: { backend: 'orca', state: 'ready' }
      })
    ).toBe('orca')
  })

  it('uses the project preference before activation', () => {
    expect(
      resolveTerminalBackend({
        globalDefault: 'orca',
        preference: 'herdr'
      })
    ).toBe('herdr')
  })

  it('blocks Orca to Herdr migration while legacy PTYs are alive', () => {
    expect(
      planTerminalBackendChange({
        activation: { backend: 'orca', state: 'ready' },
        target: 'herdr',
        migrationId: 'migration-1',
        liveLegacyPtyIds: ['setup-pty', 'terminal-pty']
      })
    ).toEqual({
      kind: 'blocked',
      source: 'orca',
      target: 'herdr',
      liveLegacyPtyIds: ['setup-pty', 'terminal-pty']
    })
  })

  it('treats only an explicit project override as a migration request', () => {
    const activation = { backend: 'orca', state: 'ready' } as const
    expect(
      resolveDesiredTerminalBackend({
        globalDefault: 'herdr',
        preference: 'inherit',
        activation
      })
    ).toBe('orca')
    expect(
      resolveDesiredTerminalBackend({
        globalDefault: 'orca',
        preference: 'herdr',
        activation
      })
    ).toBe('herdr')
  })
})

describe('normalizeHerdrSessionName', () => {
  it('trims a valid shared session name', () => {
    expect(normalizeHerdrSessionName('  shared-session  ')).toBe('shared-session')
    expect(normalizeHerdrSessionName('orca')).toBe('orca')
  })

  it('rejects non-string, blank, and oversized values', () => {
    expect(normalizeHerdrSessionName(42)).toBeUndefined()
    expect(normalizeHerdrSessionName('   ')).toBeUndefined()
    expect(normalizeHerdrSessionName('a'.repeat(65))).toBeUndefined()
  })

  it('accepts the maximum-length name', () => {
    expect(normalizeHerdrSessionName('a'.repeat(64))).toBe('a'.repeat(64))
  })
})

describe('normalizeHerdrRuntimeSource', () => {
  it('keeps stock from PATH as the default runtime source', () => {
    expect(normalizeHerdrRuntimeSource(undefined)).toBe('stock')
    expect(normalizeHerdrRuntimeSource('stock')).toBe('stock')
  })

  it('accepts the explicit built-in daemon source', () => {
    expect(normalizeHerdrRuntimeSource('daemon')).toBe('daemon')
  })

  it('rejects unknown values as the stock runtime', () => {
    expect(normalizeHerdrRuntimeSource('custom')).toBe('stock')
    expect(normalizeHerdrRuntimeSource(42)).toBe('stock')
  })
})
