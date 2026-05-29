import { describe, expect, it } from 'vitest'
import type { CliInstallStatus } from '../../../../shared/cli-install-types'
import { installCliFromFeatureTip } from './feature-tip-cli-install-action'

function cliStatus(overrides: Partial<CliInstallStatus> = {}): CliInstallStatus {
  return {
    platform: 'darwin',
    commandName: 'orca',
    commandPath: '/usr/local/bin/orca',
    pathDirectory: '/usr/local/bin',
    pathConfigured: true,
    launcherPath: '/Applications/Orca.app/Contents/MacOS/orca',
    installMethod: 'symlink',
    supported: true,
    state: 'installed',
    currentTarget: null,
    unsupportedReason: null,
    detail: null,
    ...overrides
  }
}

describe('feature tip CLI install action', () => {
  it('returns installed after a successful CLI registration', async () => {
    const status = cliStatus()

    await expect(installCliFromFeatureTip(async () => status)).resolves.toEqual({
      kind: 'installed',
      status
    })
  })

  it('returns needs-attention when installation does not finish cleanly', async () => {
    const status = cliStatus({
      state: 'conflict',
      detail: 'Another orca command is already on PATH.'
    })

    await expect(installCliFromFeatureTip(async () => status)).resolves.toEqual({
      kind: 'needs-attention',
      status
    })
  })

  it('returns needs-attention when the launcher is installed but not visible on PATH', async () => {
    const status = cliStatus({
      pathConfigured: false,
      detail: 'Restart your shell so PATH includes /usr/local/bin.'
    })

    await expect(installCliFromFeatureTip(async () => status)).resolves.toEqual({
      kind: 'needs-attention',
      status
    })
  })
})
