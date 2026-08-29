import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileEmulatorAgentControlRow } from './MobileEmulatorAgentControlRow'

const mocks = vi.hoisted(() => ({
  canUseLocalSkillFreshness: true,
  freshnessSkillName: undefined as string | undefined
}))

vi.mock('@/hooks/useActiveProjectSkillRuntime', () => ({
  useActiveProjectSkillRuntime: () => ({
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
  AgentSkillSetupPanel: ({ freshnessSkillName }: { freshnessSkillName?: string }) => {
    mocks.freshnessSkillName = freshnessSkillName
    return null
  }
}))

vi.mock('./SetupStepBadge', () => ({ StepBadge: () => null }))
vi.mock('./MobileEmulatorExamples', () => ({ MobileEmulatorExamples: () => null }))

describe('MobileEmulatorAgentControlRow freshness authority', () => {
  beforeEach(() => {
    mocks.canUseLocalSkillFreshness = true
    mocks.freshnessSkillName = undefined
  })

  it('exposes local freshness only for a resolved local non-WSL runtime', () => {
    renderToStaticMarkup(<MobileEmulatorAgentControlRow />)
    expect(mocks.freshnessSkillName).toBe('orca-cli')

    mocks.canUseLocalSkillFreshness = false
    renderToStaticMarkup(<MobileEmulatorAgentControlRow />)
    expect(mocks.freshnessSkillName).toBeUndefined()
  })
})
