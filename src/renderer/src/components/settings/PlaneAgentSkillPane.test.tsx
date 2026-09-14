// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ORCA_PLANE_SKILL_INSTALL_COMMAND,
  ORCA_PLANE_SKILL_NAME
} from '@/lib/agent-feature-install-commands'
import { getPlaneUsageExamples } from '@/lib/plane-usage-examples'
import { PlaneAgentSkillPane } from './PlaneAgentSkillPane'

const UPDATE_COMMAND = 'npx skills update orca-plane --global'

const mocks = vi.hoisted(() => ({
  panelProps: [] as Record<string, unknown>[],
  runtime: 'native' as 'native' | 'wsl',
  skillInstalled: true,
  updateSkillName: 'orca-plane',
  planeConnected: true,
  visibleTaskProviders: ['github', 'plane'] as string[],
  openSettingsPage: vi.fn(),
  openSettingsTarget: vi.fn()
}))

vi.mock('./AgentSkillSetupPanel', () => ({
  AgentSkillSetupPanel: (props: Record<string, unknown> & { footer?: ReactNode }) => {
    mocks.panelProps.push(props)
    return (
      <section>
        {!props.hideHeader && <h3>{String(props.title)}</h3>}
        {props.description != null && <p>{String(props.description)}</p>}
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

vi.mock('@/lib/plane-agent-skill-update-command', () => ({
  getPlaneAgentSkillUpdateTarget: () => ({
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
    installDisabledReason: null,
    canUseLocalSkillFreshness: mocks.runtime !== 'wsl'
  })
}))

vi.mock('@/hooks/usePlaneProviderConnected', () => ({
  usePlaneProviderConnected: () => mocks.planeConnected
}))

vi.mock('@/components/plane-connect-dialog', () => ({
  PlaneConnectDialog: () => null
}))

vi.mock('@/store', () => ({
  useAppStore: (
    selector: (state: {
      openSettingsPage: () => void
      openSettingsTarget: (target: unknown) => void
      settings: { visibleTaskProviders: string[] }
      planeStatusChecked: boolean
      checkPlaneConnection: () => void
      settingsSearchQuery: string
    }) => unknown
  ) =>
    selector({
      openSettingsPage: mocks.openSettingsPage,
      openSettingsTarget: mocks.openSettingsTarget,
      settings: { visibleTaskProviders: mocks.visibleTaskProviders },
      planeStatusChecked: true,
      checkPlaneConnection: vi.fn(),
      settingsSearchQuery: ''
    })
}))

let root: Root | null = null
let container: HTMLDivElement | null = null

async function renderPane(): Promise<HTMLDivElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(<PlaneAgentSkillPane />)
  })
  return container
}

describe('PlaneAgentSkillPane', () => {
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
    mocks.updateSkillName = 'orca-plane'
    mocks.planeConnected = true
    mocks.visibleTaskProviders = ['github', 'plane']
    mocks.openSettingsPage.mockClear()
    mocks.openSettingsTarget.mockClear()
  })

  it('keeps a clickable route to the Integrations credentials pane', async () => {
    const rendered = await renderPane()
    const link = [...rendered.querySelectorAll('button')].find(
      (button) => button.textContent === 'Integrations'
    )

    expect(link).toBeDefined()
    await act(async () => {
      link?.click()
    })

    expect(mocks.openSettingsPage).toHaveBeenCalled()
    expect(mocks.openSettingsTarget).toHaveBeenCalledWith({
      pane: 'integrations',
      repoId: null,
      sectionId: 'integrations-plane'
    })
  })

  it('routes the connected checklist credential action to Integrations', async () => {
    const rendered = await renderPane()
    const manageAccess = [...rendered.querySelectorAll('button')].find(
      (button) => button.textContent === 'Manage access'
    )

    expect(manageAccess).toBeDefined()
    await act(async () => {
      manageAccess?.click()
    })

    expect(mocks.openSettingsTarget).toHaveBeenCalledWith({
      pane: 'integrations',
      repoId: null,
      sectionId: 'integrations-plane'
    })
  })

  it('does not pass an icon the hideHeader layout would drop', () => {
    renderToStaticMarkup(<PlaneAgentSkillPane />)

    expect(mocks.panelProps.at(-1)).not.toHaveProperty('icon')
  })

  it('renders checklist with inlined skill panel and usage examples', () => {
    const markup = renderToStaticMarkup(<PlaneAgentSkillPane />)

    expect(markup).toContain('Setup checklist')
    expect(markup).toContain('2. Install the agent skill')
    expect(mocks.panelProps.at(-1)).toEqual(
      expect.objectContaining({ hideHeader: true, description: null })
    )
    expect(markup).not.toContain('Agent skill')
    expect(markup).not.toContain('Ready below')
    expect(markup).toContain('Example prompts')
    expect(markup).toContain('Good to know')
    expect(markup).toContain('Start from a Plane issue')
    expect(markup).toContain('All set')
    expect(markup.indexOf('Example prompts')).toBeLessThan(markup.indexOf('Good to know'))
    const examples = getPlaneUsageExamples()
    expect(examples).toHaveLength(5)
    for (const example of examples) {
      expect(markup).toContain(example.title)
      expect(example.prompt).toContain('/orca-plane')
      expect(example.prompt).not.toContain('{{value0}}')
    }
  })

  it('shows incomplete checklist when the skill is missing', () => {
    mocks.skillInstalled = false
    const markup = renderToStaticMarkup(<PlaneAgentSkillPane />)

    expect(markup).toContain('2 of 3 ready')
    expect(mocks.panelProps.at(-1)).toEqual(
      expect.objectContaining({ hideHeader: true, description: null })
    )
  })

  it('passes the orca-plane install/update commands and freshness on a local runtime', async () => {
    await renderPane()

    expect(mocks.panelProps.at(-1)).toEqual(
      expect.objectContaining({
        command: ORCA_PLANE_SKILL_INSTALL_COMMAND,
        installedCommand: UPDATE_COMMAND,
        freshnessSkillName: ORCA_PLANE_SKILL_NAME
      })
    )
  })

  it('drops freshness on a WSL runtime the local scan cannot vouch for', async () => {
    mocks.runtime = 'wsl'
    await renderPane()

    expect(mocks.panelProps.at(-1)?.freshnessSkillName).toBeUndefined()
  })

  it('checks freshness under the legacy name when that is the installed update target', async () => {
    mocks.updateSkillName = 'plane-tickets'
    await renderPane()

    expect(mocks.panelProps.at(-1)?.freshnessSkillName).toBe('plane-tickets')
  })
})
