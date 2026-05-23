import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CliInstallStatus } from '../../../shared/cli-install-types'
import {
  ensureOrcaCliAvailableForAgentSkillTerminal,
  isOrcaCliAvailableOnPath
} from './agent-skill-cli-prerequisite'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    warning: vi.fn()
  }
}))

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

describe('isOrcaCliAvailableOnPath', () => {
  it('requires the installed CLI command to be visible on PATH', () => {
    expect(isOrcaCliAvailableOnPath(cliStatus())).toBe(true)
    expect(isOrcaCliAvailableOnPath(cliStatus({ pathConfigured: false }))).toBe(false)
    expect(isOrcaCliAvailableOnPath(cliStatus({ state: 'not_installed' }))).toBe(false)
  })
})

describe('ensureOrcaCliAvailableForAgentSkillTerminal', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('runs the CLI installer when the command exists but is not visible on PATH', async () => {
    const initial = cliStatus({
      pathConfigured: false,
      detail: '/usr/local/bin is not currently visible on PATH.'
    })
    const installed = cliStatus()
    const getInstallStatus = vi.fn().mockResolvedValue(initial)
    const install = vi.fn().mockResolvedValue(installed)
    const onStatusChange = vi.fn()

    vi.stubGlobal('window', {
      api: {
        cli: {
          getInstallStatus,
          install
        }
      }
    })

    await expect(ensureOrcaCliAvailableForAgentSkillTerminal({ onStatusChange })).resolves.toBe(
      installed
    )

    expect(install).toHaveBeenCalledTimes(1)
    expect(onStatusChange).toHaveBeenNthCalledWith(1, initial)
    expect(onStatusChange).toHaveBeenNthCalledWith(2, installed)
  })
})
