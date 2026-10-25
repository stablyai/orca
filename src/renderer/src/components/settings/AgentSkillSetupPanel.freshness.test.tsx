// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { planOf, sharedEntry } from '../skills/bundled-skill-plan-fixtures.test-support'
import { AgentSkillSetupPanel } from './AgentSkillSetupPanel'

const mocks = vi.hoisted(() => ({ plan: vi.fn() }))
const TARGET = { kind: 'environment', environmentId: 'agents-host' } as const
vi.mock('@/hooks/useActiveProjectSkillRuntime', () => ({
  useActiveProjectSkillRuntime: () => ({ bundledSkillTarget: TARGET })
}))
vi.mock('@/runtime/runtime-bundled-skills-client', () => ({
  planBundledSkillsOnTarget: mocks.plan,
  executeBundledSkillsOnTarget: vi.fn()
}))
vi.mock('@/hooks/useSkillFreshness', () => ({ refreshSkillFreshness: vi.fn() }))
afterEach(cleanup)
beforeEach(() => mocks.plan.mockReset())

function panel(onRecheck: () => Promise<void>): React.JSX.Element {
  return (
    <AgentSkillSetupPanel
      title="Linear skill"
      description={null}
      skillNames={['orca-linear']}
      installed
      loading={false}
      error={null}
      hideHeader
      freshnessSkillName="orca-linear"
      onRecheck={onRecheck}
    />
  )
}

it('refreshes the button and pill from one named plan after the discovery re-check finishes', async () => {
  let finish: (() => void) | undefined
  const onRecheck = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  mocks.plan
    .mockResolvedValueOnce({ kind: 'plan', plan: planOf([sharedEntry('orca-linear', 'update')]) })
    .mockResolvedValueOnce({ kind: 'plan', plan: planOf([sharedEntry('orca-linear', 'keep')]) })
  render(panel(onRecheck))
  expect(await screen.findByText('Update available')).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Re-check' }))
  expect(mocks.plan).toHaveBeenCalledTimes(1)
  finish?.()
  expect(await screen.findByText('Up to date')).toBeDefined()
  expect(screen.queryByRole('button', { name: 'Update' })).toBeNull()
  expect(mocks.plan).toHaveBeenLastCalledWith(TARGET, { names: ['orca-linear'] })
})

it('shows a failed verdict when the named post-recheck plan fails', async () => {
  mocks.plan
    .mockResolvedValueOnce({ kind: 'plan', plan: planOf([sharedEntry('orca-linear', 'update')]) })
    .mockRejectedValueOnce(new Error('plan unavailable'))
  render(panel(vi.fn(async () => {})))
  expect(await screen.findByText('Update available')).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Re-check' }))
  await waitFor(() => expect(screen.getByText('Check failed')).toBeDefined())
  expect(screen.queryByText('Installed')).toBeNull()
  expect(screen.queryByText('Up to date')).toBeNull()
})
