// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { doneResult, planEntry, planOf, planOp } from '../bundled-skill-plan-fixtures.test-support'
import { AgentSkillSetupPanel } from './AgentSkillSetupPanel'

const mocks = vi.hoisted(() => ({ plan: vi.fn(), execute: vi.fn(), requestDetails: vi.fn() }))
const TARGET = { kind: 'environment', environmentId: 'agents-host' } as const
vi.mock('@/hooks/useActiveProjectSkillRuntime', () => ({
  useActiveProjectSkillRuntime: () => ({ bundledSkillTarget: TARGET })
}))
vi.mock('@/runtime/skills/bundled/runtime-bundled-skills-client', () => ({
  planBundledSkillsOnTarget: mocks.plan,
  executeBundledSkillsOnTarget: mocks.execute
}))
vi.mock('@/hooks/installed-agent-skill-discovery', async (importOriginal) => ({
  ...(await importOriginal()),
  notifyInstalledAgentSkillsChanged: vi.fn()
}))
vi.mock('@/hooks/useInstalledAgentSkills', async (importOriginal) => ({
  ...(await importOriginal()),
  notifyInstalledAgentSkillsRefreshed: vi.fn()
}))
vi.mock('@/hooks/useSkillFreshness', () => ({
  refreshSkillFreshness: vi.fn(),
  useSkillFreshness: () => ({ plan: null, loading: false, error: null })
}))
vi.mock('../skill-freshness-update-dialog', () => ({
  requestSkillFreshnessUpdateDialog: mocks.requestDetails
}))
afterEach(cleanup)
beforeEach(() => {
  mocks.plan.mockReset()
  mocks.execute.mockReset()
  mocks.requestDetails.mockReset()
})

it('keeps an absent skill installable without installed-copy details', async () => {
  const pending = planOf([
    planEntry('orca-cli', [
      planOp('write', '/home/u/.agents/skills/orca-cli'),
      planOp('link', '/home/u/.codex/skills/orca-cli', { agents: ['codex'] })
    ])
  ])
  mocks.plan.mockResolvedValue({ kind: 'plan', plan: pending })
  mocks.execute.mockResolvedValue(doneResult(pending))
  render(
    <AgentSkillSetupPanel
      title="Orca skill for agents"
      description={null}
      skillNames={['orca-cli']}
      installed={false}
      loading={false}
      error={null}
      variant="row"
      onRecheck={vi.fn()}
      target={TARGET}
    />
  )

  await screen.findByText('Not installed', { exact: true })
  const install = screen.getByRole('button', { name: 'Install' })
  expect(install.hasAttribute('disabled')).toBe(false)
  expect(screen.getByText('Not installed', { exact: true })).toBeDefined()
  expect(screen.queryByText('Installed', { exact: true })).toBeNull()
  expect(screen.getByRole('button', { name: 'Re-check' }).hasAttribute('disabled')).toBe(false)
  expect(screen.queryByRole('button', { name: 'Details' })).toBeNull()
  fireEvent.click(install)
  await waitFor(() =>
    expect(mocks.execute).toHaveBeenCalledWith(TARGET, 'b'.repeat(64), { names: ['orca-cli'] })
  )
})

it.each([
  { reason: 'edited', hideHeader: false },
  { reason: 'other', hideHeader: false },
  { reason: 'edited', hideHeader: true },
  { reason: 'other', hideHeader: true },
  { reason: 'edited', hideHeader: false, variant: 'row' },
  { reason: 'other', hideHeader: false, variant: 'row' }
] as const)(
  'reviews a skipped $reason copy before and after installing for other agents (hideHeader=$hideHeader)',
  async ({ reason, hideHeader, ...options }) => {
    const keptCopy = planOp('leave', '/home/u/.claude/skills/orca-cli', {
      reason,
      replaceable: true,
      observed: { kind: 'folder', entries: ['SKILL.md:file'], skillDigest: 'c'.repeat(64) }
    })
    const pending = planOf([
      planEntry('orca-cli', [
        planOp('write', '/home/u/.agents/skills/orca-cli'),
        keptCopy,
        planOp('link', '/home/u/.cursor/skills/orca-cli', { agents: ['cursor'] }),
        planOp('link', '/home/u/.codex/skills/orca-cli', { agents: ['codex'] })
      ])
    ])
    const installed = planOf([
      planEntry(
        'orca-cli',
        pending.skills[0].ops.map((op) =>
          op.kind === 'leave' ? op : { ...op, kind: 'keep' as const }
        )
      )
    ])
    mocks.plan.mockResolvedValue({ kind: 'plan', plan: pending })
    mocks.execute.mockImplementation(async () => {
      mocks.plan.mockResolvedValue({ kind: 'plan', plan: installed })
      return doneResult(pending)
    })
    render(
      <AgentSkillSetupPanel
        title="Browser Use"
        description={null}
        skillNames={['orca-cli']}
        installed
        loading={false}
        error={null}
        hideHeader={hideHeader}
        variant={'variant' in options ? options.variant : undefined}
        onRecheck={vi.fn()}
      />
    )

    const install = await screen.findByRole('button', { name: 'Install for 2 more agents' })
    expect(screen.getByText('Review skill')).toBeDefined()
    expect(screen.queryByText('Installed')).toBeNull()
    expect(screen.getByRole('button', { name: 'Details' })).toBeDefined()
    expect(install.hasAttribute('disabled')).toBe(false)

    fireEvent.click(install)

    await screen.findByRole('button', { name: "Replace with Orca's copy" })
    expect(screen.getByText('Review skill')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Details' })).toBeDefined()
    expect(mocks.execute).toHaveBeenCalledOnce()
  }
)
