// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  doneResult,
  planEntry,
  planOf,
  planOp
} from '../skills/bundled-skill-plan-fixtures.test-support'
import { AgentSkillSetupPanel } from './AgentSkillSetupPanel'

const mocks = vi.hoisted(() => ({ plan: vi.fn(), execute: vi.fn() }))
const TARGET = { kind: 'environment', environmentId: 'agents-host' } as const
vi.mock('@/hooks/useActiveProjectSkillRuntime', () => ({
  useActiveProjectSkillRuntime: () => ({ bundledSkillTarget: TARGET })
}))
vi.mock('@/runtime/runtime-bundled-skills-client', () => ({
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
afterEach(cleanup)
beforeEach(() => {
  mocks.plan.mockReset()
  mocks.execute.mockReset()
})

it('keeps Check failed when the plan request fails', async () => {
  mocks.plan.mockRejectedValue(new Error('connection lost'))
  render(
    <AgentSkillSetupPanel
      title="Orchestration"
      description={null}
      skillNames={['orchestration']}
      installed
      loading={false}
      error={null}
      onRecheck={vi.fn()}
    />
  )
  expect(await screen.findByText('Check failed')).toBeDefined()
  expect(screen.getByRole('button', { name: 'Re-check' })).toBeDefined()
  expect(screen.queryByRole('button', { name: 'Update' })).toBeNull()
  expect(screen.queryByText('Update Orca on the server to install its skills.')).toBeNull()
})

it('uses the named plan for its pill when a detected agent still needs the skill', async () => {
  mocks.plan.mockResolvedValue({
    kind: 'plan',
    plan: planOf([
      planEntry('orchestration', [
        planOp('keep', '/home/u/.claude/skills/orchestration', {
          observed: { kind: 'link', target: '/home/u/.agents/skills/orchestration' }
        }),
        planOp('link', '/home/u/.cursor/skills/orchestration', { agents: ['cursor'] })
      ])
    ])
  })
  render(
    <AgentSkillSetupPanel
      title="Orchestration"
      description={null}
      skillNames={['orchestration']}
      freshnessSkillName="orchestration"
      installed
      loading={false}
      error={null}
      onRecheck={vi.fn()}
    />
  )
  expect(await screen.findByRole('button', { name: 'Install for Cursor' })).toBeDefined()
  expect(screen.queryByText('Up to date')).toBeNull()
  expect(screen.getByRole('button', { name: 'Details' })).toBeDefined()
})

it.each([
  { kind: 'leave', label: 'Review skill', details: true },
  { kind: 'keep', label: 'Up to date', details: false }
] as const)(
  'uses $label even when the surface has no separate freshness inventory',
  async ({ kind, label, details }) => {
    mocks.plan.mockResolvedValue({
      kind: 'plan',
      plan: planOf([
        planEntry('orca-cli', [
          planOp(kind, '/home/u/.claude/skills/orca-cli', {
            observed: { kind: 'folder', entries: ['SKILL.md:file'], skillDigest: 'c'.repeat(64) },
            ...(kind === 'leave' ? { reason: 'edited', replaceable: true } : {})
          })
        ])
      ])
    })
    render(
      <AgentSkillSetupPanel
        title="Browser Use"
        description={null}
        skillNames={['orca-cli']}
        installed
        loading={false}
        error={null}
        onRecheck={vi.fn()}
      />
    )
    expect(await screen.findByText(label)).toBeDefined()
    expect(Boolean(screen.queryByRole('button', { name: 'Details' }))).toBe(details)
  }
)

it.each([
  { reason: 'edited', hideHeader: false },
  { reason: 'other', hideHeader: false },
  { reason: 'edited', hideHeader: true },
  { reason: 'other', hideHeader: true }
] as const)(
  'reviews a skipped $reason copy before and after installing for other agents (hideHeader=$hideHeader)',
  async ({ reason, hideHeader }) => {
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
