// @vitest-environment happy-dom

import { renderToStaticMarkup } from 'react-dom/server'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { CliSection } from './CliSection'

type CapturedPanelProps = {
  skillNames: readonly string[]
  installedSkillNames?: readonly string[]
  target?: { kind: string; environmentId?: string } | null
  terminalRuntime?: { runtime: 'host' | 'wsl'; wslDistro?: string | null; label: string }
  freshnessSkillName?: string
  onBeforeInstall?: () => Promise<void>
}

const capturedPanel = vi.hoisted(
  (): {
    canUseSkillFreshness: boolean
    transportTarget: { kind: 'local' } | { kind: 'environment'; environmentId: string } | null
    props: CapturedPanelProps | null
    useInstalledAgentSkill: ReturnType<typeof vi.fn>
  } => ({
    canUseSkillFreshness: true,
    transportTarget: { kind: 'local' },
    props: null,
    useInstalledAgentSkill: vi.fn()
  })
)
const toastError = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({ toast: { error: toastError, success: vi.fn() } }))

vi.mock('@/hooks/useInstalledAgentSkills', () => ({
  GLOBAL_AGENT_SKILL_SOURCE_KINDS: ['global'],
  useInstalledAgentSkill: capturedPanel.useInstalledAgentSkill
}))

vi.mock('@/hooks/use-active-skill-discovery-runtime-target', () => ({
  useActiveSkillDiscoveryRuntimeTarget: () => capturedPanel.transportTarget
}))

vi.mock('@/hooks/useActiveProjectSkillRuntime', () => ({
  useActiveProjectSkillRuntime: () => ({
    canUseSkillFreshness: capturedPanel.canUseSkillFreshness,
    bundledSkillTarget: capturedPanel.canUseSkillFreshness ? { kind: 'local' } : null
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
  capturedPanel.canUseSkillFreshness = true
  capturedPanel.transportTarget = { kind: 'local' }
  toastError.mockReset()
  vi.unstubAllGlobals()
})

vi.mock('./AgentSkillSetupPanel', () => ({
  AgentSkillSetupPanel: function AgentSkillSetupPanel(props: CapturedPanelProps) {
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
  it.each([null, { kind: 'environment', environmentId: 'focused-remote' }] as const)(
    'keeps explicit host setup local while the workspace transport is %j',
    (transportTarget) => {
      capturedPanel.transportTarget = transportTarget
      renderToStaticMarkup(
        <CliSection currentPlatform="darwin" settings={getDefaultSettings('/tmp')} />
      )
      expect(capturedPanel.useInstalledAgentSkill).toHaveBeenLastCalledWith(
        'orca-cli',
        expect.objectContaining({ runtimeTarget: { kind: 'local' }, discoveryTarget: undefined })
      )
      expect(capturedPanel.props?.target).toEqual({ kind: 'local' })
      expect(capturedPanel.props?.terminalRuntime?.runtime).toBe('host')
    }
  )
  it('exposes freshness only for a resolved local host runtime', () => {
    const settings = getDefaultSettings('/tmp')
    renderToStaticMarkup(<CliSection currentPlatform="darwin" settings={settings} />)
    expect(capturedPanel.props?.freshnessSkillName).toBe('orca-cli')

    capturedPanel.canUseSkillFreshness = false
    renderToStaticMarkup(<CliSection currentPlatform="darwin" settings={settings} />)
    expect(capturedPanel.props?.freshnessSkillName).toBeUndefined()

    capturedPanel.canUseSkillFreshness = true
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

  it('targets the default project WSL distro without registering the CLI', async () => {
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

    expect(capturedPanel.useInstalledAgentSkill).toHaveBeenCalledWith(
      'orca-cli',
      expect.objectContaining({
        discoveryTarget: { runtime: 'wsl', wslDistro: 'Ubuntu' },
        runtimeTarget: { kind: 'local' },
        sourceKinds: ['global']
      })
    )
    expect(capturedPanel.props?.skillNames).toEqual(['orca-cli'])
    expect(capturedPanel.props?.terminalRuntime).toMatchObject({
      runtime: 'wsl',
      wslDistro: 'Ubuntu'
    })
    expect(capturedPanel.props?.target).toBeNull()
    expect(capturedPanel.props?.installedSkillNames).toBeUndefined()
    expect(capturedPanel.props?.onBeforeInstall).toBeUndefined()
    expect(getWslInstallStatus).not.toHaveBeenCalled()
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
