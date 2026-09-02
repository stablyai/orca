// @vitest-environment happy-dom

import { cleanup, fireEvent, render } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskSourceLinearSetup } from './TaskSourceLinearSetup'

const mocks = vi.hoisted(() => ({
  skillInstalled: false,
  skillLoading: false,
  checkLinearConnection: vi.fn(),
  panelProps: [] as { installed?: boolean }[]
}))

vi.mock('./AgentSkillSetupPanel', () => ({
  AgentSkillSetupPanel: (props: { installed?: boolean }) => {
    mocks.panelProps.push(props)
    return <div data-testid="skill-panel">{props.installed ? 'Installed' : 'Not installed'}</div>
  }
}))

vi.mock('./CliSkillRuntimeSetup', () => ({
  buildSkillCommandForRuntime: (command: string) => command,
  ensureWslCliAvailableForAgentSkillTerminal: vi.fn(),
  getWslCliDistroRequest: () => undefined
}))

vi.mock('@/lib/linear-agent-skill-update-command', () => ({
  getLinearAgentSkillUpdateTarget: () => ({
    command: 'npx skills update orca-linear --global',
    skillName: 'orca-linear'
  })
}))

vi.mock('@/hooks/useInstalledAgentSkills', () => ({
  GLOBAL_AGENT_SKILL_SOURCE_KINDS: ['home'],
  useInstalledAgentSkillNames: () => ({
    installed: mocks.skillInstalled,
    loading: mocks.skillLoading,
    error: null,
    skills: [],
    refresh: vi.fn()
  })
}))

vi.mock('@/hooks/useActiveProjectSkillRuntime', () => ({
  useActiveProjectSkillRuntime: () => ({
    discoveryTarget: undefined,
    agentRuntime: { runtime: 'native' },
    terminalShellOverride: undefined,
    installDisabledReason: null,
    canUseLocalSkillFreshness: true
  })
}))

vi.mock('@/components/linear-api-key-dialog', () => ({
  LinearApiKeyDialog: () => null
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: { checkLinearConnection: () => void }) => unknown) =>
    selector({ checkLinearConnection: mocks.checkLinearConnection })
}))

function setupElement(
  overrides: {
    connected?: boolean
    visible?: boolean
    onOpenIntegrations?: () => void
  } = {}
): React.JSX.Element {
  return (
    <TaskSourceLinearSetup
      connected={overrides.connected ?? false}
      checking={false}
      visible={overrides.visible ?? true}
      canHide
      onToggleVisible={vi.fn()}
      onOpenIntegrations={overrides.onOpenIntegrations ?? vi.fn()}
    />
  )
}

function renderSetup(overrides: { connected?: boolean; visible?: boolean } = {}): string {
  return renderToStaticMarkup(setupElement(overrides))
}

describe('TaskSourceLinearSetup', () => {
  beforeEach(() => {
    mocks.skillInstalled = false
    mocks.skillLoading = false
    mocks.panelProps = []
  })

  afterEach(() => {
    cleanup()
  })

  it('blocks first-time skill install until Linear is connected', () => {
    const markup = renderSetup({ connected: false })

    expect(markup).toContain('Connect Linear first')
    expect(markup).not.toContain('data-testid="skill-panel"')
  })

  it('shows the skill panel as done when the skill is already installed without a connection', () => {
    mocks.skillInstalled = true
    const markup = renderSetup({ connected: false })

    expect(markup).not.toContain('Connect Linear first')
    expect(markup).toContain('data-testid="skill-panel"')
    expect(markup).toContain('Installed')
    expect(mocks.panelProps.at(-1)).toEqual(expect.objectContaining({ installed: true }))
  })

  it('keeps the skill panel visible while a scan is in flight without a connection', () => {
    mocks.skillLoading = true
    const markup = renderSetup({ connected: false })

    expect(markup).not.toContain('Connect Linear first')
    expect(markup).toContain('data-testid="skill-panel"')
  })

  it('shows the install panel when connected and the skill is missing', () => {
    const markup = renderSetup({ connected: true })

    expect(markup).toContain('data-testid="skill-panel"')
    expect(markup).toContain('Not installed')
    expect(markup).not.toContain('Connect Linear first')
  })

  it('routes connected credential management to Integrations', () => {
    const onOpenIntegrations = vi.fn()
    const rendered = render(setupElement({ connected: true, onOpenIntegrations }))

    fireEvent.click(rendered.getByRole('button', { name: 'Manage keys' }))

    expect(onOpenIntegrations).toHaveBeenCalledOnce()
  })
})
