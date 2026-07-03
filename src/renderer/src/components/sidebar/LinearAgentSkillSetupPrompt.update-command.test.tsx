// @vitest-environment happy-dom

import { join } from 'node:path'
import { act, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { CliInstallStatus } from '../../../../shared/cli-install-types'
import type { DiscoveredSkill } from '../../../../shared/skills'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LinearAgentSkillSetupPrompt,
  _linearAgentSkillSetupPromptInternalsForTests
} from './LinearAgentSkillSetupPrompt'

const mocks = vi.hoisted(() => ({
  skillState: {
    installed: true,
    loading: false,
    error: null as string | null,
    skills: [] as DiscoveredSkill[],
    refresh: vi.fn(async () => {})
  },
  useInstalledAgentSkillNames: vi.fn(),
  getCliStatus: vi.fn(),
  panelProps: [] as Record<string, unknown>[]
}))

vi.mock('@/hooks/useInstalledAgentSkills', async (importOriginal) => ({
  ...(await importOriginal()),
  useInstalledAgentSkillNames: mocks.useInstalledAgentSkillNames
}))

vi.mock('@/lib/agent-skill-cli-prerequisite', () => ({
  AGENT_SKILL_CLI_PREREQUISITE_NOTICE: 'CLI registration notice',
  ensureOrcaCliAvailableForAgentSkillTerminal: vi.fn(async () => null),
  isOrcaCliAvailableOnPath: (status: CliInstallStatus | null | undefined) =>
    status?.state === 'installed' && status.pathConfigured
}))

vi.mock('../settings/CliSkillRuntimeSetup', () => ({
  buildSkillCommandForRuntime: (command: string) => command,
  ensureWslCliAvailableForAgentSkillTerminal: vi.fn(async () => null),
  getWslCliDistroRequest: () => undefined
}))

vi.mock('../settings/AgentSkillSetupPanel', () => ({
  AgentSkillSetupPanel: (props: Record<string, unknown> & { children?: ReactNode }) => {
    mocks.panelProps.push(props)
    return <section data-testid="linear-skill-panel">{String(props.installedCommand)}</section>
  }
}))

let root: Root | null = null
let container: HTMLDivElement | null = null

function cliStatus(): CliInstallStatus {
  return {
    platform: 'darwin',
    commandName: 'orca',
    commandPath: null,
    pathDirectory: null,
    pathConfigured: false,
    launcherPath: '/Applications/Orca.app/Contents/MacOS/Orca',
    installMethod: null,
    supported: true,
    state: 'not_installed',
    currentTarget: null,
    unsupportedReason: null,
    detail: null
  }
}

function discoveredSkill(overrides: Partial<DiscoveredSkill>): DiscoveredSkill {
  return {
    id: 'skill-1',
    name: 'orca-linear',
    description: null,
    providers: ['agent-skills'],
    sourceKind: 'home',
    sourceLabel: 'Agent skills home',
    rootPath: '/Users/test/.agents/skills',
    directoryPath: '/Users/test/.agents/skills/orca-linear',
    skillFilePath: '/Users/test/.agents/skills/orca-linear/SKILL.md',
    installed: true,
    fileCount: 1,
    updatedAt: null,
    ...overrides
  }
}

function legacyLinearSkillPath(overrides: Partial<DiscoveredSkill> = {}): DiscoveredSkill {
  return discoveredSkill({
    name: 'linear-tickets',
    directoryPath: join('Users', 'test', '.agents', 'skills', 'linear-tickets'),
    skillFilePath: join('Users', 'test', '.agents', 'skills', 'linear-tickets', 'SKILL.md'),
    ...overrides
  })
}

async function renderPrompt(
  props: Partial<ComponentProps<typeof LinearAgentSkillSetupPrompt>> = {}
): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <LinearAgentSkillSetupPrompt linked={true} remote={false} surface="modal" {...props} />
    )
  })
  await act(async () => {})
}

describe('LinearAgentSkillSetupPrompt update command', () => {
  beforeEach(() => {
    mocks.skillState.installed = true
    mocks.skillState.loading = false
    mocks.skillState.error = null
    mocks.skillState.refresh.mockReset()
    mocks.skillState.refresh.mockImplementation(async () => {})
    mocks.useInstalledAgentSkillNames.mockReset()
    mocks.useInstalledAgentSkillNames.mockReturnValue(mocks.skillState)
    mocks.getCliStatus.mockReset()
    mocks.getCliStatus.mockResolvedValue(cliStatus())
    mocks.panelProps.length = 0
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { cli: { getInstallStatus: mocks.getCliStatus } }
    })
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => null,
        setItem: vi.fn(),
        removeItem: vi.fn()
      }
    })
    _linearAgentSkillSetupPromptInternalsForTests.resetSessionReminders()
  })

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount()
      })
    }
    root = null
    container?.remove()
    container = null
    Reflect.deleteProperty(window, 'api')
    _linearAgentSkillSetupPromptInternalsForTests.resetSessionReminders()
  })

  it('uses the canonical update command when the canonical Linear skill is installed', async () => {
    mocks.skillState.skills = [discoveredSkill({ name: 'orca-linear' })]

    await renderPrompt()

    expect(mocks.panelProps.at(-1)).toEqual(
      expect.objectContaining({ installedCommand: 'npx skills update orca-linear --global' })
    )
  })

  it('uses the legacy update command when only the legacy Linear skill is installed', async () => {
    mocks.skillState.skills = [legacyLinearSkillPath()]

    await renderPrompt()

    expect(mocks.panelProps.at(-1)).toEqual(
      expect.objectContaining({ installedCommand: 'npx skills update linear-tickets --global' })
    )
  })

  it('prefers the canonical update command when both Linear skill names are installed', async () => {
    mocks.skillState.skills = [discoveredSkill({ name: 'orca-linear' }), legacyLinearSkillPath()]

    await renderPrompt()

    expect(mocks.panelProps.at(-1)).toEqual(
      expect.objectContaining({ installedCommand: 'npx skills update orca-linear --global' })
    )
  })
})
