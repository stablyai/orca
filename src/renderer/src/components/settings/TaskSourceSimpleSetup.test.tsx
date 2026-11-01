// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { doneResult, planOf, sharedEntry } from '../skills/bundled-skill-plan-fixtures.test-support'
import { TooltipProvider } from '../ui/tooltip'
import { JiraSetupSteps } from './TaskSourceSimpleSetup'

const WRITE_PLAN = planOf([sharedEntry('orca-jira', 'write')])

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  dialogOpen: [] as boolean[]
}))

const skillMocks = vi.hoisted(() => ({
  skillTarget: { kind: 'local' } as const,
  plan: vi.fn(),
  execute: vi.fn()
}))

vi.mock('@/components/jira-connect-dialog', () => ({
  JiraConnectDialog: ({ open }: { open: boolean }) => {
    mocks.dialogOpen.push(open)
    return null
  }
}))

vi.mock('@/runtime/runtime-bundled-skills-client', () => ({
  planBundledSkillsOnTarget: skillMocks.plan,
  executeBundledSkillsOnTarget: skillMocks.execute
}))

vi.mock('@/hooks/useActiveProjectSkillRuntime', () => ({
  useActiveProjectSkillRuntime: () => ({
    bundledSkillTarget: skillMocks.skillTarget,
    installDisabledReason: null,
    canUseSkillFreshness: false
  })
}))

vi.mock('@/hooks/useInstalledAgentSkills', async (importOriginal) => ({
  ...(await importOriginal()),
  useInstalledAgentSkill: () => ({
    installed: false,
    loading: false,
    settled: true,
    installedUnverifiable: false,
    error: null,
    skills: [],
    sources: [],
    refresh: async () => true
  })
}))

vi.mock('@/hooks/installed-agent-skill-discovery', () => ({
  notifyInstalledAgentSkillsChanged: vi.fn()
}))

function renderSteps(connected: boolean): ReturnType<typeof render> {
  return render(
    <TooltipProvider>
      <JiraSetupSteps
        connected={connected}
        checking={false}
        visible
        canHide
        onToggleVisible={vi.fn()}
        onConnected={vi.fn()}
        onOpenIntegrations={vi.fn()}
      />
    </TooltipProvider>
  )
}

beforeEach(() => {
  skillMocks.plan.mockReset()
  skillMocks.plan.mockResolvedValue({ kind: 'plan', plan: WRITE_PLAN })
  skillMocks.execute.mockReset()
  skillMocks.execute.mockResolvedValue(doneResult(WRITE_PLAN))
})

afterEach(() => {
  cleanup()
  mocks.dialogOpen = []
})

describe('JiraSetupSteps', () => {
  it('routes connected credential management to Integrations', () => {
    const onOpenIntegrations = vi.fn()
    const rendered = render(
      <JiraSetupSteps
        connected
        checking={false}
        visible
        canHide
        onToggleVisible={vi.fn()}
        onConnected={vi.fn()}
        onOpenIntegrations={onOpenIntegrations}
      />
    )

    fireEvent.click(rendered.getByRole('button', { name: 'Manage keys' }))

    expect(onOpenIntegrations).toHaveBeenCalledOnce()
    expect(mocks.dialogOpen.at(-1)).toBe(false)
  })

  it("installs orca-jira with Orca's installer on the active host", async () => {
    const rendered = renderSteps(true)

    const install = await rendered.findByRole('button', { name: 'Install' })
    await act(async () => {
      fireEvent.click(install)
    })

    expect(skillMocks.plan).toHaveBeenCalledWith({ kind: 'local' }, { names: ['orca-jira'] })
    expect(skillMocks.execute).toHaveBeenCalledWith({ kind: 'local' }, WRITE_PLAN.planDigest, {
      names: ['orca-jira']
    })
  })

  it('asks for a Jira connection before offering the skill install', () => {
    const rendered = renderSteps(false)

    expect(
      rendered.getByText('Connect Jira first, then install the skill for agents.')
    ).toBeTruthy()
    expect(rendered.queryByRole('button', { name: 'Install' })).toBeNull()
  })
})
