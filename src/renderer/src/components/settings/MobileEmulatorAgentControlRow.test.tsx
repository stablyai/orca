import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCA_CLI_SKILL_INSTALL_COMMAND } from '@/lib/agent-feature-install-commands'
import type { ProjectAgentSkillRuntime } from '@/lib/project-skill-runtime'
import { MobileEmulatorAgentControlRow } from './MobileEmulatorAgentControlRow'

const mocks = vi.hoisted(() => ({
  agentRuntime: undefined as ProjectAgentSkillRuntime | undefined,
  canUseLocalSkillFreshness: true,
  command: '',
  freshnessSkillName: undefined as string | undefined,
  terminalRuntime: undefined as ProjectAgentSkillRuntime | undefined
}))

vi.mock('@/hooks/useActiveProjectSkillRuntime', () => ({
  useActiveProjectSkillRuntime: () => ({
    agentRuntime: mocks.agentRuntime,
    canUseLocalSkillFreshness: mocks.canUseLocalSkillFreshness,
    terminalShellOverride: undefined
  })
}))

vi.mock('../emulator-pane/use-mobile-emulator-agent-setup-state', () => ({
  useMobileEmulatorAgentSetupState: () => ({
    cliActionLabel: 'Enable',
    cliBusy: false,
    cliEnabled: true,
    cliInstallStatus: null,
    cliLoading: false,
    cliSkillError: null,
    cliSkillInstalled: true,
    cliSkillLoading: false,
    cliSupported: true,
    completedCount: 2,
    handleEnableCli: vi.fn(),
    refreshCliSkill: vi.fn(),
    step2Blocked: false
  })
}))

vi.mock('./AgentSkillSetupPanel', () => ({
  AgentSkillSetupPanel: ({
    command,
    freshnessSkillName,
    terminalRuntime
  }: {
    command: string
    freshnessSkillName?: string
    terminalRuntime?: ProjectAgentSkillRuntime
  }) => {
    mocks.command = command
    mocks.freshnessSkillName = freshnessSkillName
    mocks.terminalRuntime = terminalRuntime
    return null
  }
}))

vi.mock('./SetupStepBadge', () => ({ StepBadge: () => null }))
vi.mock('./MobileEmulatorExamples', () => ({ MobileEmulatorExamples: () => null }))

describe('MobileEmulatorAgentControlRow freshness authority', () => {
  beforeEach(() => {
    mocks.agentRuntime = undefined
    mocks.canUseLocalSkillFreshness = true
    mocks.command = ''
    mocks.freshnessSkillName = undefined
    mocks.terminalRuntime = undefined
  })

  it('exposes local freshness only for a resolved local non-WSL runtime', () => {
    renderToStaticMarkup(<MobileEmulatorAgentControlRow />)
    expect(mocks.freshnessSkillName).toBe('orca-cli')

    mocks.canUseLocalSkillFreshness = false
    renderToStaticMarkup(<MobileEmulatorAgentControlRow />)
    expect(mocks.freshnessSkillName).toBeUndefined()
  })

  it('builds the install command for the focused execution host', () => {
    mocks.agentRuntime = {
      runtime: 'host',
      hostPlatform: 'win32',
      runtimeEnvironmentId: null,
      runtimeOwnershipResolved: true,
      terminalWindowsShell: 'powershell.exe',
      label: 'Windows'
    }
    renderToStaticMarkup(<MobileEmulatorAgentControlRow />)
    expect(mocks.command).toContain('cmd.exe /d /s /c')
    expect(mocks.terminalRuntime).toMatchObject({ runtime: 'host', hostPlatform: 'win32' })

    mocks.agentRuntime = { runtime: 'host', hostPlatform: 'linux', label: 'This device' }
    renderToStaticMarkup(<MobileEmulatorAgentControlRow />)
    expect(mocks.command).toBe(ORCA_CLI_SKILL_INSTALL_COMMAND)
    expect(mocks.terminalRuntime).toEqual(mocks.agentRuntime)
  })

  it('routes a project WSL skill install through its Windows host', () => {
    mocks.agentRuntime = {
      runtime: 'wsl',
      wslDistro: 'Ubuntu',
      hostPlatform: 'win32',
      terminalWindowsShell: 'powershell.exe',
      label: 'WSL Ubuntu'
    }

    renderToStaticMarkup(<MobileEmulatorAgentControlRow />)

    expect(mocks.command).toContain('cmd.exe /d /s /c')
    expect(mocks.terminalRuntime).toEqual({
      runtime: 'host',
      hostPlatform: 'win32',
      runtimeEnvironmentId: null,
      runtimeOwnershipResolved: true,
      terminalWindowsShell: 'powershell.exe',
      label: 'Windows'
    })
  })
})
