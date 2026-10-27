// @vitest-environment happy-dom

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
