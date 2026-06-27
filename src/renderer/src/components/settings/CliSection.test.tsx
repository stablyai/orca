import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { CliSection } from './CliSection'

const capturedPanel = vi.hoisted(() => ({
  props: null as null | {
    command: string
    installedCommand: string
    getPrerequisiteStatus: () => Promise<unknown>
    onBeforeOpenTerminal: () => Promise<void>
  },
  useInstalledAgentSkill: vi.fn()
}))

vi.mock('@/hooks/useInstalledAgentSkills', () => ({
  GLOBAL_AGENT_SKILL_SOURCE_KINDS: ['global'],
  useInstalledAgentSkill: capturedPanel.useInstalledAgentSkill
}))

capturedPanel.useInstalledAgentSkill.mockReturnValue({
  installed: false,
  loading: false,
  error: null,
  refresh: vi.fn()
})

vi.mock('./AgentSkillSetupPanel', () => ({
  AgentSkillSetupPanel: function AgentSkillSetupPanel(props: {
    command: string
    installedCommand: string
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
  WslCliRegistration: function WslCliRegistration() {
    return null
  }
}))

describe('CliSection project runtime defaults', () => {
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
    expect(capturedPanel.props?.command).toContain("wsl.exe -d 'Ubuntu' -- sh -c")
    expect(capturedPanel.props?.command).toContain('npx skills add')
    expect(capturedPanel.props?.installedCommand).toContain("wsl.exe -d 'Ubuntu' -- sh -c")
    expect(capturedPanel.props?.installedCommand).toContain('npx skills update orca-cli --global')
    expect(getWslInstallStatus).toHaveBeenCalledWith({ distro: 'Ubuntu' })
    expect(getWslInstallStatus).toHaveBeenCalledTimes(2)
  })
})
