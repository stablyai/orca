// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ORCA_LINEAR_SKILL_INSTALL_COMMAND,
  ORCA_LINEAR_SKILL_NAME
} from '@/lib/agent-feature-install-commands'
import { getLinearUsageExamples } from '@/lib/linear-usage-examples'
import { LinearAgentSkillPane } from './LinearAgentSkillPane'

const UPDATE_COMMAND = 'npx skills update orca-linear --global'

const mocks = vi.hoisted(() => ({
  panelProps: [] as Record<string, unknown>[],
  runtime: 'native' as 'native' | 'wsl',
  skillInstalled: true,
  updateSkillName: 'orca-linear'
}))

vi.mock('./AgentSkillSetupPanel', () => ({
  AgentSkillSetupPanel: (props: Record<string, unknown> & { footer?: ReactNode }) => {
    mocks.panelProps.push(props)
    return (
      <section>
        <h3>{String(props.title)}</h3>
        <span>{props.installed ? 'Installed' : 'Not installed'}</span>
        <code>{String(props.command)}</code>
        <code>{String(props.installedCommand)}</code>
        <span data-testid="freshness">{String(props.freshnessSkillName)}</span>
      </section>
    )
  }
}))

vi.mock('./CliSkillRuntimeSetup', () => ({
  buildSkillCommandForRuntime: (command: string) => command,
  ensureWslCliAvailableForAgentSkillTerminal: vi.fn(),
  getWslCliDistroRequest: () => undefined
}))

vi.mock('@/lib/linear-agent-skill-update-command', () => ({
  getLinearAgentSkillUpdateTarget: () => ({
    command: UPDATE_COMMAND,
    skillName: mocks.updateSkillName
  })
}))

vi.mock('@/hooks/useInstalledAgentSkills', () => ({
  GLOBAL_AGENT_SKILL_SOURCE_KINDS: ['home'],
  useInstalledAgentSkillNames: () => ({
    installed: mocks.skillInstalled,
    loading: false,
    error: null,
    skills: [],
    refresh: vi.fn()
  })
}))

vi.mock('@/hooks/useActiveProjectSkillRuntime', () => ({
  useActiveProjectSkillRuntime: () => ({
    discoveryTarget: undefined,
    agentRuntime: { runtime: mocks.runtime },
    terminalShellOverride: undefined,
    installDisabledReason: null
  })
}))

let root: Root | null = null
let container: HTMLDivElement | null = null

async function renderPane(): Promise<HTMLDivElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(<LinearAgentSkillPane />)
  })
  return container
}

describe('LinearAgentSkillPane', () => {
  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount()
      })
    }
    root = null
    container?.remove()
    container = null
    mocks.panelProps.length = 0
    mocks.runtime = 'native'
    mocks.skillInstalled = true
    mocks.updateSkillName = 'orca-linear'
  })

  it('renders the Linear skill card and the usage examples', () => {
    const markup = renderToStaticMarkup(<LinearAgentSkillPane />)

    expect(markup).toContain('Linear skill')
    expect(markup).toContain('How to use it')
    const examples = getLinearUsageExamples()
    expect(examples).toHaveLength(5)
    for (const example of examples) {
      expect(markup).toContain(example.title)
      expect(example.prompt).toContain('/orca-linear')
      expect(example.prompt).not.toContain('{{value0}}')
    }
  })

  it('passes the orca-linear install/update commands and freshness on a local runtime', async () => {
    await renderPane()

    expect(mocks.panelProps.at(-1)).toEqual(
      expect.objectContaining({
        command: ORCA_LINEAR_SKILL_INSTALL_COMMAND,
        installedCommand: UPDATE_COMMAND,
        freshnessSkillName: ORCA_LINEAR_SKILL_NAME
      })
    )
  })

  it('drops freshness on a WSL runtime the local scan cannot vouch for', async () => {
    mocks.runtime = 'wsl'
    await renderPane()

    expect(mocks.panelProps.at(-1)?.freshnessSkillName).toBeUndefined()
  })

  it('checks freshness under the legacy name when that is the installed update target', async () => {
    mocks.updateSkillName = 'linear-tickets'
    await renderPane()

    expect(mocks.panelProps.at(-1)?.freshnessSkillName).toBe('linear-tickets')
  })
})
