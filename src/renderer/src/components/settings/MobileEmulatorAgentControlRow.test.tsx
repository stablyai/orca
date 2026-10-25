import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileEmulatorAgentControlRow } from './MobileEmulatorAgentControlRow'

const mocks = vi.hoisted(
  (): {
    canUseSkillFreshness: boolean
    freshnessSkillName: string | undefined
    panelProps: Record<string, unknown>
  } => ({
    canUseSkillFreshness: true,
    freshnessSkillName: undefined,
    panelProps: {}
  })
)

vi.mock('@/hooks/useActiveProjectSkillRuntime', () => ({
  useActiveProjectSkillRuntime: () => ({
    canUseSkillFreshness: mocks.canUseSkillFreshness
  })
}))

vi.mock('../emulator-pane/use-mobile-emulator-agent-setup-state', () => ({
  useMobileEmulatorAgentSetupState: () => ({
    cliSkillError: null,
    cliSkillInstalled: true,
    cliSkillLoading: false,
    recheckSetup: vi.fn(),
    refreshCliSkill: vi.fn(),
    setupComplete: true,
    setupRechecking: false,
    statusReady: true,
    skillRuntime: {
      canUseSkillFreshness: mocks.canUseSkillFreshness,
      bundledSkillTarget: { kind: 'local' }
    }
  })
}))

vi.mock('./AgentSkillSetupPanel', () => ({
  AgentSkillSetupPanel: (props: Record<string, unknown> & { freshnessSkillName?: string }) => {
    mocks.freshnessSkillName = props.freshnessSkillName
    mocks.panelProps = props
    return null
  }
}))

vi.mock('./MobileEmulatorExamples', () => ({ MobileEmulatorExamples: () => null }))

describe('MobileEmulatorAgentControlRow freshness authority', () => {
  beforeEach(() => {
    mocks.canUseSkillFreshness = true
    mocks.freshnessSkillName = undefined
  })

  it('exposes local freshness only for a resolved local non-WSL runtime', () => {
    renderToStaticMarkup(<MobileEmulatorAgentControlRow />)
    expect(mocks.freshnessSkillName).toBe('orca-cli')

    mocks.canUseSkillFreshness = false
    renderToStaticMarkup(<MobileEmulatorAgentControlRow />)
    expect(mocks.freshnessSkillName).toBeUndefined()
  })

  it('installs the skill without registering the CLI first', () => {
    renderToStaticMarkup(<MobileEmulatorAgentControlRow />)
    expect(mocks.panelProps.onBeforeOpenTerminal).toBeUndefined()
    expect(mocks.panelProps.preInstallNotice).toBeUndefined()
    expect(mocks.panelProps.installDisabled).toBe(false)
  })
})
