// @vitest-environment happy-dom

import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ProjectAgentSkillRuntime } from '@/lib/project-skill-runtime'
import type { DiscoveredSkill } from '../../../../shared/skills'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../ui/tooltip'
import { LinearAgentSkillInstallCta } from './linear-agent-skill-install-cta'

const mocks = vi.hoisted(() => ({
  agentRuntime: ((): ProjectAgentSkillRuntime | undefined => undefined)(),
  skillState: {
    installed: false,
    loading: false,
    error: null as string | null,
    skills: [] as DiscoveredSkill[],
    refresh: vi.fn(async () => true)
  },
  useInstalledAgentSkillNames: vi.fn(),
  plan: vi.fn(async () => ({ kind: 'unsupported', reason: 'update-server' }))
}))

vi.mock('@/hooks/use-bundled-skill-install-action', () => ({
  useBundledSkillInstallAction: () => ({ kind: 'run' })
}))

vi.mock('@/hooks/useInstalledAgentSkills', async (importOriginal) => ({
  ...(await importOriginal()),
  useInstalledAgentSkillNames: mocks.useInstalledAgentSkillNames
}))

vi.mock('@/runtime/runtime-bundled-skills-client', () => ({
  planBundledSkillsOnTarget: mocks.plan,
  executeBundledSkillsOnTarget: vi.fn()
}))

vi.mock('@/hooks/useActiveProjectSkillRuntime', () => ({
  useActiveProjectSkillRuntime: () => ({
    bundledSkillTarget: mocks.agentRuntime?.runtime === 'wsl' ? null : { kind: 'local' },
    agentRuntime: mocks.agentRuntime
  })
}))

let root: Root | null = null
let container: HTMLDivElement | null = null

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
    updatedAt: null,
    ...overrides
  }
}

async function renderCta(
  props: Partial<ComponentProps<typeof LinearAgentSkillInstallCta>> = {}
): Promise<HTMLDivElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <TooltipProvider>
        <LinearAgentSkillInstallCta
          settings={{ activeRuntimeEnvironmentId: null, terminalWindowsShell: '' }}
          {...props}
        />
      </TooltipProvider>
    )
  })
  if (!container) {
    throw new Error('Container was not created')
  }
  return container
}

describe('LinearAgentSkillInstallCta', () => {
  beforeEach(() => {
    mocks.skillState.installed = false
    mocks.agentRuntime = undefined
    mocks.skillState.loading = false
    mocks.skillState.error = null
    mocks.skillState.skills = []
    mocks.skillState.refresh.mockClear()
    mocks.useInstalledAgentSkillNames.mockReset()
    mocks.useInstalledAgentSkillNames.mockReturnValue(mocks.skillState)
    mocks.plan.mockClear()
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
  })

  it('offers Install and the explanation when the skill is missing', async () => {
    const rendered = await renderCta()

    expect(rendered.textContent).toContain('Agent skill:')
    expect(rendered.textContent).toContain('orca-linear')
    expect(rendered.textContent).toContain('Not installed')
    expect(rendered.textContent).toContain(
      'Full guided setup (connect + skill + visibility) is under Settings → Task Sources.'
    )
    expect(rendered.textContent).toContain('Install skill')
    expect(rendered.textContent).not.toContain('Copy command')
  })

  it("installs the skill directly on the agents' host", async () => {
    const rendered = await renderCta()

    await act(async () => {
      Array.from(rendered.querySelectorAll('button'))
        .find((button) => button.textContent === 'Install skill')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mocks.plan).toHaveBeenCalledWith({ kind: 'local' }, { names: ['orca-linear'] })
    expect(rendered.textContent).toContain('Update Orca on the server to install its skills.')
  })

  it('shows a subtle confirmation and Update when installed', async () => {
    mocks.skillState.installed = true
    mocks.skillState.skills = [discoveredSkill({ name: 'orca-linear' })]

    const rendered = await renderCta()

    expect(rendered.textContent).toContain('Installed')
    expect(rendered.textContent).toContain('Update')
    expect(rendered.textContent).not.toContain('Not installed')
  })

  it('updates through the legacy skill name when only linear-tickets is installed', async () => {
    mocks.skillState.installed = true
    mocks.skillState.skills = [
      discoveredSkill({
        name: 'linear-tickets',
        directoryPath: '/Users/test/.agents/skills/linear-tickets',
        skillFilePath: '/Users/test/.agents/skills/linear-tickets/SKILL.md'
      })
    ]

    const rendered = await renderCta()

    await act(async () => {
      Array.from(rendered.querySelectorAll('button'))
        .find((button) => button.textContent === 'Update')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mocks.plan).toHaveBeenCalledWith({ kind: 'local' }, { names: ['linear-tickets'] })
  })

  it('notes that remote agent environments need their own setup', async () => {
    const rendered = await renderCta({
      settings: { activeRuntimeEnvironmentId: 'runtime-1', terminalWindowsShell: '' }
    })

    expect(rendered.textContent).toContain(
      'This installs host setup; remote agent environments may need separate setup.'
    )
  })

  it('keeps the resolved WSL project on the old command flow', async () => {
    mocks.agentRuntime = { runtime: 'wsl', wslDistro: 'Debian', label: 'WSL Debian' }
    const rendered = await renderCta()
    expect(rendered.textContent).toContain(
      `npx skills@1.7.2 add https://github.com/stablyai/orca/tree/${'0'.repeat(40)} --skill orca-linear --global`
    )
    expect(rendered.textContent).not.toContain('Install skill')
    expect(mocks.plan).not.toHaveBeenCalled()
    expect(mocks.useInstalledAgentSkillNames).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ discoveryTarget: { runtime: 'wsl', wslDistro: 'Debian' } })
    )
  })

  it('uses project host discovery even when legacy global settings still prefer WSL', async () => {
    mocks.agentRuntime = { runtime: 'host', label: 'Windows' }
    await renderCta({
      settings: {
        localAgentRuntime: 'wsl',
        localAgentWslDistro: 'Ubuntu',
        terminalWindowsShell: 'wsl.exe'
      }
    })
    expect(mocks.useInstalledAgentSkillNames).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ discoveryTarget: undefined })
    )
  })

  it('re-checks the skill scan on demand', async () => {
    const rendered = await renderCta()

    await act(async () => {
      Array.from(rendered.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('Re-check'))
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mocks.skillState.refresh).toHaveBeenCalledTimes(1)
  })
})
