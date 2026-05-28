import { afterEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { CliInstallStatus } from '../../../shared/cli-install-types'
import {
  CLI_PREREQUISITE_REGISTRATION_TOAST,
  CLI_PREREQUISITE_REGISTRATION_TOAST_DESCRIPTION,
  ensureOrcaCliAvailableForAgentSkillTerminal,
  isOrcaCliAvailableOnPath
} from './agent-skill-cli-prerequisite'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    message: vi.fn(),
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
    vi.useRealTimers()
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

    await expect(
      ensureOrcaCliAvailableForAgentSkillTerminal({
        onStatusChange,
        registrationPromptDelayMs: 0
      })
    ).resolves.toBe(installed)

    expect(install).toHaveBeenCalledTimes(1)
    expect(toast.message).toHaveBeenCalledWith(CLI_PREREQUISITE_REGISTRATION_TOAST, {
      description: CLI_PREREQUISITE_REGISTRATION_TOAST_DESCRIPTION
    })
    expect(onStatusChange).toHaveBeenNthCalledWith(1, initial)
    expect(onStatusChange).toHaveBeenNthCalledWith(2, installed)
  })

  it('lets the registration toast paint before opening the native installer', async () => {
    vi.useFakeTimers()
    const initial = cliStatus({ state: 'stale' })
    const installed = cliStatus()
    const getInstallStatus = vi.fn().mockResolvedValue(initial)
    const install = vi.fn().mockResolvedValue(installed)

    vi.stubGlobal('window', {
      setTimeout,
      api: {
        cli: {
          getInstallStatus,
          install
        }
      }
    })

    const pending = ensureOrcaCliAvailableForAgentSkillTerminal({ registrationPromptDelayMs: 700 })
    await vi.waitFor(() => {
      expect(toast.message).toHaveBeenCalledWith(CLI_PREREQUISITE_REGISTRATION_TOAST, {
        description: CLI_PREREQUISITE_REGISTRATION_TOAST_DESCRIPTION
      })
    })
    expect(install).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(700)
    await expect(pending).resolves.toBe(installed)
    expect(install).toHaveBeenCalledTimes(1)
  })
})
