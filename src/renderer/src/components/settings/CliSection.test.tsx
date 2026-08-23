// @vitest-environment happy-dom

import { renderToStaticMarkup } from 'react-dom/server'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import {
  ORCA_CLI_SKILL_INSTALL_COMMAND,
  ORCA_CLI_SKILL_UPDATE_COMMAND
} from '@/lib/agent-feature-install-commands'
import { CliSection } from './CliSection'

const capturedPanel = vi.hoisted(() => ({
  canUseLocalSkillFreshness: true,
  wslRegistrationPlatforms: [] as string[],
  props: null as null | {
    command: string
    installedCommand: string
    terminalRuntime?: {
      runtime: 'host' | 'wsl'
      wslDistro?: string | null
      hostPlatform?: NodeJS.Platform
      terminalWindowsShell?: string | null
      label: string
    }
    freshnessSkillName?: string
    getPrerequisiteStatus: () => Promise<unknown>
    onBeforeOpenTerminal: () => Promise<void>
  },
  useInstalledAgentSkill: vi.fn()
}))
const toastError = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({ toast: { error: toastError, success: vi.fn() } }))

vi.mock('@/hooks/useInstalledAgentSkills', () => ({
  GLOBAL_AGENT_SKILL_SOURCE_KINDS: ['global'],
  useInstalledAgentSkill: capturedPanel.useInstalledAgentSkill
}))

vi.mock('@/hooks/useActiveProjectSkillRuntime', () => ({
  useActiveProjectSkillRuntime: () => ({
    canUseLocalSkillFreshness: capturedPanel.canUseLocalSkillFreshness
  })
}))

capturedPanel.useInstalledAgentSkill.mockReturnValue({
  installed: false,
  loading: false,
  error: null,
  refresh: vi.fn()
})

afterEach(() => {
  cleanup()
  capturedPanel.canUseLocalSkillFreshness = true
  capturedPanel.wslRegistrationPlatforms.length = 0
  toastError.mockReset()
  vi.unstubAllGlobals()
})

vi.mock('./AgentSkillSetupPanel', () => ({
  AgentSkillSetupPanel: function AgentSkillSetupPanel(props: {
    command: string
    installedCommand: string
    freshnessSkillName?: string
    getPrerequisiteStatus: () => Promise<unknown>
    onBeforeOpenTerminal: () => Promise<void>
  }) {
    capturedPanel.props = props
    return <div data-testid="agent-skill-setup-panel" />
  }
}))

vi.mock('./CliRegistrationDialog', () => ({
  CliRegistrationDialog: function CliRegistrationDialog() {
    return null
  }
}))

vi.mock('./WslCliRegistration', () => ({
  WslCliRegistration: function WslCliRegistration(props: { currentPlatform: string }) {
    capturedPanel.wslRegistrationPlatforms.push(props.currentPlatform)
    return null
  }
}))

describe('CliSection project runtime defaults', () => {
  it('exposes freshness only for a resolved local host runtime', () => {
    const settings = getDefaultSettings('/tmp')
    renderToStaticMarkup(<CliSection currentPlatform="darwin" settings={settings} />)
    expect(capturedPanel.props?.freshnessSkillName).toBe('orca-cli')
    expect(capturedPanel.props?.terminalRuntime).toMatchObject({
      runtime: 'host',
      hostPlatform: 'darwin'
    })

    renderToStaticMarkup(<CliSection settings={settings} />)
    expect(capturedPanel.props?.terminalRuntime?.hostPlatform).toBeUndefined()
    expect(capturedPanel.props?.command).toBe(ORCA_CLI_SKILL_INSTALL_COMMAND)

    capturedPanel.canUseLocalSkillFreshness = false
    renderToStaticMarkup(<CliSection currentPlatform="darwin" settings={settings} />)
    expect(capturedPanel.props?.freshnessSkillName).toBeUndefined()

    capturedPanel.canUseLocalSkillFreshness = true
    renderToStaticMarkup(
      <CliSection
        currentPlatform="win32"
        settings={{
          ...settings,
          localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' }
        }}
        wslSupportedPlatform
        wslAvailable
      />
    )
    expect(capturedPanel.props?.freshnessSkillName).toBeUndefined()
  })

  it('passes the default project WSL distro to CLI skill prerequisite checks', async () => {
    const getWslInstallStatus = vi
      .fn()
      .mockResolvedValue({ supported: true, state: 'installed', pathConfigured: true })
    vi.stubGlobal('window', {
      api: {
        cli: {
          getInstallStatus: vi.fn(),
          getWslInstallStatus,
          installWsl: vi.fn()
        },
        shell: { openPath: vi.fn() }
      }
    })

    renderToStaticMarkup(
      <CliSection
        currentPlatform="win32"
        settings={{
          ...getDefaultSettings('/tmp'),
          localAgentRuntime: 'host',
          localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' }
        }}
        wslSupportedPlatform
        wslAvailable
        wslCapabilitiesLoading={false}
      />
    )

    await capturedPanel.props?.getPrerequisiteStatus()
    await capturedPanel.props?.onBeforeOpenTerminal()

    expect(capturedPanel.useInstalledAgentSkill).toHaveBeenCalledWith(
      'orca-cli',
      expect.objectContaining({
        discoveryTarget: { runtime: 'wsl', wslDistro: 'Ubuntu' },
        sourceKinds: ['global']
      })
    )
    expect(capturedPanel.props?.command).toBe(ORCA_CLI_SKILL_INSTALL_COMMAND)
    expect(capturedPanel.props?.installedCommand).toBe(ORCA_CLI_SKILL_UPDATE_COMMAND)
    expect(capturedPanel.props?.terminalRuntime).toEqual({
      runtime: 'wsl',
      wslDistro: 'Ubuntu',
      hostPlatform: 'win32',
      label: 'WSL Ubuntu'
    })
    expect(getWslInstallStatus).toHaveBeenCalledWith({ distro: 'Ubuntu' })
    expect(getWslInstallStatus).toHaveBeenCalledTimes(2)
  })

  it('keeps registration viewer-owned and skill commands execution-host-owned', () => {
    const settings = { ...getDefaultSettings('/tmp'), terminalWindowsShell: 'powershell.exe' }
    renderToStaticMarkup(
      <CliSection
        currentPlatform="linux"
        settings={settings}
        executionHostRuntime={{
          runtime: 'host',
          hostPlatform: 'win32',
          terminalWindowsShell: 'git-bash',
          label: 'Windows'
        }}
      />
    )
    expect(capturedPanel.props?.command).toBe(ORCA_CLI_SKILL_INSTALL_COMMAND)
    expect(capturedPanel.props?.terminalRuntime).toMatchObject({
      hostPlatform: 'win32',
      terminalWindowsShell: 'git-bash'
    })
    expect(capturedPanel.wslRegistrationPlatforms).toEqual([])

    renderToStaticMarkup(
      <CliSection
        currentPlatform="win32"
        settings={settings}
        wslSupportedPlatform
        executionHostRuntime={{ runtime: 'host', hostPlatform: 'linux', label: 'This device' }}
      />
    )
    expect(capturedPanel.wslRegistrationPlatforms).toContain('win32')

    for (const terminalWindowsShell of ['powershell.exe', undefined]) {
      renderToStaticMarkup(
        <CliSection
          currentPlatform="linux"
          settings={{ ...settings, terminalWindowsShell: 'git-bash' }}
          executionHostRuntime={{
            runtime: 'host',
            hostPlatform: 'win32',
            terminalWindowsShell,
            label: 'Windows'
          }}
        />
      )
      expect(capturedPanel.props?.command?.startsWith('cmd.exe')).toBe(
        terminalWindowsShell === 'powershell.exe'
      )
    }
  })

  it('renders an inline unknown PATH state without offering a mutation', async () => {
    const getInstallStatus = vi.fn().mockResolvedValue({
      platform: 'win32',
      commandName: 'orca',
      commandPath: 'C:\\Program Files\\Orca\\resources\\bin\\orca.exe',
      pathDirectory: 'C:\\Program Files\\Orca\\resources\\bin',
      pathConfigured: null,
      launcherPath: 'C:\\Program Files\\Orca\\resources\\bin\\orca.exe',
      installMethod: 'wrapper',
      supported: true,
      state: 'installed',
      currentTarget: 'C:\\Program Files\\Orca\\resources\\bin\\orca.exe',
      unsupportedReason: null,
      detail: 'Orca could not read the Windows user PATH registry value.'
    })
    Object.assign(window, {
      api: {
        cli: {
          getInstallStatus,
          getWslInstallStatus: vi.fn(),
          install: vi.fn(),
          remove: vi.fn()
        },
        shell: { openPath: vi.fn() }
      }
    })

    render(<CliSection currentPlatform="win32" settings={getDefaultSettings('/tmp')} />)

    expect(await screen.findByText(/could not read the Windows user PATH/i)).toBeDefined()
    const registrationSwitch = screen.getByRole('switch') as HTMLButtonElement
    expect(registrationSwitch.disabled).toBe(true)
    expect(registrationSwitch.getAttribute('aria-checked')).toBe('false')
    expect(toastError).not.toHaveBeenCalled()
  })
})
