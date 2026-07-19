import { describe, expect, it } from 'vitest'
import {
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
