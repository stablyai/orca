import { describe, expect, it } from 'vitest'
import type { CliInstallStatus } from '../../../../shared/cli-install-types'
import { readCliInstallFailure, readCliInstallRejection } from './cli-install-failure'

const FALLBACK = 'Orca could not finish CLI registration and reported no reason.'

function cliStatus(overrides: Partial<CliInstallStatus> = {}): CliInstallStatus {
  return {
    platform: 'darwin',
    commandName: 'orca',
    commandPath: '/usr/local/bin/orca',
    pathDirectory: '/usr/local/bin',
    pathConfigured: true,
    launcherPath: '/Applications/Orca.app/Contents/Resources/bin/orca',
    installMethod: 'symlink',
    supported: true,
    state: 'installed',
    currentTarget: null,
    unsupportedReason: null,
    detail: null,
    ...overrides
  }
}

describe('readCliInstallFailure', () => {
  it('reports no failure for a landed registration', () => {
    expect(readCliInstallFailure(cliStatus(), FALLBACK)).toBeNull()
  })

  it('surfaces the main-process reason verbatim without re-classifying it', () => {
    expect(
      readCliInstallFailure(
        cliStatus({
          state: 'unsupported',
          supported: false,
          unsupportedReason: 'launcher_missing',
          detail: 'The bundled CLI launcher is missing from this Orca build.'
        }),
        FALLBACK
      )
    ).toEqual({
      reason: 'The bundled CLI launcher is missing from this Orca build.',
      conflictCommandPath: null
    })
  })

  it('names the conflicting path so the panel can offer the remedy', () => {
    expect(
      readCliInstallFailure(
        cliStatus({
          state: 'conflict',
          detail: '/usr/local/bin/orca exists but is not an Orca symlink.'
        }),
        FALLBACK
      )
    ).toEqual({
      reason: '/usr/local/bin/orca exists but is not an Orca symlink.',
      conflictCommandPath: '/usr/local/bin/orca'
    })
  })

  it('falls back when the main process reported no detail', () => {
    expect(readCliInstallFailure(cliStatus({ state: 'not_installed' }), FALLBACK)).toEqual({
      reason: FALLBACK,
      conflictCommandPath: null
    })
  })
})

describe('readCliInstallRejection', () => {
  it('strips the Electron transport prefix off the installer message', () => {
    expect(
      readCliInstallRejection(
        new Error(
          "Error invoking remote method 'cli:install': Error: Refusing to replace non-Orca " +
            'command at /usr/local/bin/orca. Remove it and register again if it is no longer needed.'
        ),
        FALLBACK
      )
    ).toEqual({
      reason:
        'Refusing to replace non-Orca command at /usr/local/bin/orca. ' +
        'Remove it and register again if it is no longer needed.',
      conflictCommandPath: null
    })
  })

  it('keeps the registration-lock remedy that names the lock file', () => {
    const failure = readCliInstallRejection(
      new Error(
        "Error invoking remote method 'cli:install': Error: Timed out waiting for another Orca " +
          'process to finish CLI registration (waited 330s). If no other Orca is running, remove ' +
          '/home/u/.cache/orca/appimage/.cli-registration.lock and retry.'
      ),
      FALLBACK
    )

    expect(failure.reason).toContain('.cli-registration.lock and retry.')
    expect(failure.reason.startsWith('Timed out waiting')).toBe(true)
  })

  it('falls back for a non-Error rejection with no message', () => {
    expect(readCliInstallRejection(new Error('   '), FALLBACK)).toEqual({
      reason: FALLBACK,
      conflictCommandPath: null
    })
  })
})
