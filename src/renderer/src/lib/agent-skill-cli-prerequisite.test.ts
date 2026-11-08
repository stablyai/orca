import { afterEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { CliInstallStatus } from '../../../shared/cli-install-types'
import { ensureOrcaCliAvailableForAgentSkillTerminal } from './agent-skill-cli-prerequisite'

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

describe('ensureOrcaCliAvailableForAgentSkillTerminal', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('does not run the CLI installer when the Windows PATH read is unknown', async () => {
    const initial = cliStatus({
      platform: 'win32',
      pathConfigured: null,
      detail: 'Orca could not read the Windows user PATH registry value.'
    })
    const install = vi.fn()
    vi.stubGlobal('window', {
      api: { cli: { getInstallStatus: vi.fn().mockResolvedValue(initial), install } }
    })

    await expect(
      ensureOrcaCliAvailableForAgentSkillTerminal({ registrationPromptDelayMs: 0 })
    ).resolves.toBe(initial)

    expect(install).not.toHaveBeenCalled()
    expect(toast.warning).toHaveBeenCalledWith(
      expect.stringMatching(/could not check/i),
      expect.objectContaining({ description: initial.detail })
    )
  })
})
