import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CliInstallStatus } from '../../../../shared/cli-install-types'
import { getAgentSkillCliPrerequisite } from './CliSkillRuntimeSetup'

vi.mock('@/lib/agent-skill-cli-prerequisite', async (importOriginal) => ({
  ...(await importOriginal()),
  showOrcaCliRegistrationPromptToast: vi.fn(async () => {})
}))

afterEach(() => vi.unstubAllGlobals())

describe('agent skill CLI prerequisites', () => {
  it.each([undefined, { runtime: 'host', label: 'This device' } as const])(
    'does not inspect or register the host CLI for %j',
    async (runtime) => {
      const getInstallStatus = vi.fn()
      const install = vi.fn()
      const getWslInstallStatus = vi.fn()
      const installWsl = vi.fn()
      vi.stubGlobal('window', {
        api: { cli: { getInstallStatus, install, getWslInstallStatus, installWsl } }
      })

      const prerequisite = getAgentSkillCliPrerequisite(runtime)
      expect(prerequisite.preInstallNotice).toBeUndefined()
      expect(prerequisite.getPrerequisiteStatus).toBeUndefined()
      await prerequisite.ensureCli()
      for (const call of [getInstallStatus, install, getWslInstallStatus, installWsl]) {
        expect(call).not.toHaveBeenCalled()
      }
    }
  )

  it.each([' Ubuntu ', undefined])(
    'registers the CLI in the selected WSL distro: %s',
    async (distro) => {
      const missing: CliInstallStatus = {
        platform: 'linux',
        commandName: 'orca-ide',
        commandPath: null,
        pathDirectory: null,
        pathConfigured: false,
        launcherPath: null,
        installMethod: 'wrapper',
        supported: true,
        state: 'not_installed',
        currentTarget: null,
        unsupportedReason: null,
        detail: null
      }
      const getWslInstallStatus = vi.fn(async () => missing)
      const installWsl = vi.fn(async (): Promise<CliInstallStatus> => ({
        ...missing,
        state: 'installed',
        pathConfigured: true
      }))
      vi.stubGlobal('window', { api: { cli: { getWslInstallStatus, installWsl } } })

      const prerequisite = getAgentSkillCliPrerequisite({
        runtime: 'wsl',
        label: 'WSL',
        wslDistro: distro
      })
      expect(prerequisite.preInstallNotice).toBeTruthy()
      expect(await prerequisite.getPrerequisiteStatus?.()).toBe(missing)
      await prerequisite.ensureCli()
      const request = distro ? { distro: distro.trim() } : undefined
      expect(getWslInstallStatus).toHaveBeenCalledWith(request)
      expect(installWsl).toHaveBeenCalledExactlyOnceWith(request)
    }
  )
})
