// @vitest-environment happy-dom

import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProjectAgentSkillRuntime } from '@/lib/project-skill-runtime'
import type { BundledSkillTarget } from '@/lib/bundled-skill-target'
import { doneResult, planOf, sharedEntry } from '../bundled-skill-plan-fixtures.test-support'
import { TooltipProvider } from '../../ui/tooltip'
import { AgentSkillSetupPanel } from './AgentSkillSetupPanel'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => {
  const localTarget = (): BundledSkillTarget | null => ({ kind: 'local' })
  return {
    plan: vi.fn(),
    execute: vi.fn(),
    target: localTarget(),
    agentRuntime: ((): ProjectAgentSkillRuntime | undefined => undefined)(),
    installDisabledReason: ((): string | null => null)(),
    terminalShellOverride: ((): string | undefined => undefined)(),
    skillsChanged: vi.fn(),
    skillsRefreshed: vi.fn(),
    freshnessRefresh: vi.fn()
  }
})

vi.mock('@/runtime/runtime-bundled-skills-client', () => ({
  planBundledSkillsOnTarget: mocks.plan,
  executeBundledSkillsOnTarget: mocks.execute
}))

vi.mock('@/hooks/useActiveProjectSkillRuntime', () => ({
  useActiveProjectSkillRuntime: () => ({
    bundledSkillTarget: mocks.target,
    agentRuntime: mocks.agentRuntime,
    installDisabledReason: mocks.installDisabledReason,
    terminalShellOverride: mocks.terminalShellOverride
  })
}))

vi.mock('@/hooks/installed-agent-skill-discovery', () => ({
  notifyInstalledAgentSkillsChanged: mocks.skillsChanged
}))

vi.mock('@/hooks/useInstalledAgentSkills', () => ({
  notifyInstalledAgentSkillsRefreshed: mocks.skillsRefreshed
}))

vi.mock('@/hooks/useSkillFreshness', () => ({
  refreshSkillFreshness: mocks.freshnessRefresh
}))

vi.mock('../../onboarding/OnboardingInlineCommandTerminal', () => ({
  OnboardingInlineCommandTerminal: ({
    command,
    shellOverride
  }: {
    command: string
    shellOverride?: string
  }) => (
    <pre data-testid="wsl-terminal" data-shell={shellOverride}>
      {command}
    </pre>
  )
}))

const WRITE_PLAN = planOf([sharedEntry('orca-cli', 'write')])

function panelProps(
  overrides: Partial<ComponentProps<typeof AgentSkillSetupPanel>> = {}
): ComponentProps<typeof AgentSkillSetupPanel> {
  return {
    title: 'CLI skill',
    description: 'Enables agents to use Orca workflows.',
    skillNames: ['orca-cli'],
    installed: false,
    loading: false,
    error: null,
    onRecheck: vi.fn(),
    ...overrides
  }
}

let root: Root | null = null
let container: HTMLDivElement | null = null

async function renderInteractivePanel(
  overrides: Partial<ComponentProps<typeof AgentSkillSetupPanel>> = {}
): Promise<HTMLDivElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <TooltipProvider>
        <AgentSkillSetupPanel {...panelProps(overrides)} />
      </TooltipProvider>
    )
  })
  await act(async () => {})
  return container
}

function findButton(label: string): HTMLButtonElement {
  const button = Array.from((container ?? document.body).querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label
  )
  expect(button).toBeDefined()
  return button as HTMLButtonElement
}

async function clickButton(label: string): Promise<void> {
  await act(async () => {
    findButton(label).dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await act(async () => {})
}

describe('AgentSkillSetupPanel', () => {
  beforeEach(() => {
    mocks.plan.mockReset()
    mocks.plan.mockResolvedValue({ kind: 'plan', plan: WRITE_PLAN })
    mocks.execute.mockReset()
    mocks.execute.mockResolvedValue(doneResult(WRITE_PLAN))
    mocks.agentRuntime = undefined
    mocks.installDisabledReason = null
    mocks.terminalShellOverride = undefined
    mocks.target = { kind: 'local' }
    mocks.skillsChanged.mockReset()
    mocks.skillsRefreshed.mockReset()
    mocks.freshnessRefresh.mockReset()
    mocks.freshnessRefresh.mockResolvedValue(undefined)
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

  it('keeps each host its own result', async () => {
    mocks.execute.mockRejectedValue(new Error('skill-install-home-unavailable'))
    await renderInteractivePanel()
    await clickButton('Install')
    expect(container?.textContent).toContain('Needs attention')

    mocks.target = { kind: 'environment', environmentId: 'env-2' }
    await act(async () => {
      root?.render(
        <TooltipProvider>
          <AgentSkillSetupPanel {...panelProps()} />
        </TooltipProvider>
      )
    })
    expect(container?.textContent).not.toContain('Needs attention')
    expect(findButton('Install').disabled).toBe(false)

    mocks.target = { kind: 'local' }
    await act(async () => {
      root?.render(
        <TooltipProvider>
          <AgentSkillSetupPanel {...panelProps()} />
        </TooltipProvider>
      )
    })
    expect(container?.textContent).toContain('Needs attention')
  })
})
