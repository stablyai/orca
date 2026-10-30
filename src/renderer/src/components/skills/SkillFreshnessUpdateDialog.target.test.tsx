// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BundledSkillTarget } from '@/lib/bundled-skill-target'
import { AgentSkillSetupPanel } from '../settings/AgentSkillSetupPanel'
import { SkillFreshnessUpdateDialog } from './SkillFreshnessUpdateDialog'
import {
  consumeSkillFreshnessUpdateDialogRequest,
  requestSkillFreshnessUpdateDialog
} from './skill-freshness-update-dialog'
import { _resetSkillUpdateRunStore } from './skill-update-run-store'
import {
  doneResult,
  planEntry,
  planOf,
  planOp,
  sharedEntry
} from './bundled-skill-plan-fixtures.test-support'

const mocks = vi.hoisted(() => ({ plan: vi.fn(), execute: vi.fn(), localLoading: false }))
const LOCAL = { kind: 'local' } as const
const REMOTE = { kind: 'environment', environmentId: 'active-remote' } as const
const EDITED_PATH = '/home/u/.claude/skills/orca-cli'
const localPlan = planOf([
  planEntry('orca-cli', [planOp('leave', EDITED_PATH, { reason: 'edited', replaceable: true })])
])
const forcedPlan = planOf([planEntry('orca-cli', [planOp('replace', EDITED_PATH)])], 'c'.repeat(64))
const remotePlan = planOf([sharedEntry('orchestration', 'update')])

vi.mock('@/hooks/useActiveProjectSkillRuntime', () => ({
  useActiveProjectSkillRuntime: () => ({ bundledSkillTarget: REMOTE })
}))
vi.mock('@/hooks/useSkillFreshness', () => ({
  refreshSkillFreshness: vi.fn(),
  useSkillFreshness: (target: BundledSkillTarget | null) => ({
    plan: target?.kind === 'local' ? (mocks.localLoading ? null : localPlan) : remotePlan,
    loading: mocks.localLoading,
    unsupported: null,
    error: null,
    refresh: vi.fn()
  })
}))
vi.mock('@/runtime/runtime-bundled-skills-client', () => ({
  planBundledSkillsOnTarget: mocks.plan,
  executeBundledSkillsOnTarget: mocks.execute
}))
vi.mock('@/hooks/useInstalledAgentSkills', () => ({
  notifyInstalledAgentSkillsChanged: vi.fn()
}))
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>
}))

beforeEach(() => {
  mocks.localLoading = false
  mocks.plan.mockReset().mockImplementation(async (_target, request) => ({
    kind: 'plan',
    plan: request.force?.length ? forcedPlan : localPlan
  }))
  mocks.execute.mockReset().mockResolvedValue(doneResult(forcedPlan))
  consumeSkillFreshnessUpdateDialogRequest()
  _resetSkillUpdateRunStore()
})
afterEach(() => {
  cleanup()
  consumeSkillFreshnessUpdateDialogRequest()
  _resetSkillUpdateRunStore()
})

function setupAndReview(): React.JSX.Element {
  return (
    <>
      <AgentSkillSetupPanel
        title="CLI Settings"
        description={null}
        skillNames={['orca-cli']}
        target={LOCAL}
        installed
        loading={false}
        error={null}
        onRecheck={vi.fn()}
      />
      <SkillFreshnessUpdateDialog />
    </>
  )
}

it('reviews and replaces the setup panel host while a remote workspace is active', async () => {
  const view = render(setupAndReview())
  fireEvent.click(await screen.findByRole('button', { name: 'Details' }))
  const dialog = within(screen.getByRole('dialog'))
  expect(dialog.getByText('orca-cli')).toBeDefined()
  expect(dialog.queryByText('orchestration')).toBeNull()
  fireEvent.click(dialog.getByRole('button', { name: 'Show folders' }))
  expect(dialog.getByText(/~\/.claude\/skills\/orca-cli/)).toBeDefined()

  mocks.localLoading = true
  view.rerender(setupAndReview())
  expect(dialog.getByText('orca-cli')).toBeDefined()
  expect(dialog.queryByText('orchestration')).toBeNull()
  mocks.localLoading = false
  view.rerender(setupAndReview())
  fireEvent.click(dialog.getByRole('checkbox'))
  await waitFor(() => expect(mocks.plan).toHaveBeenLastCalledWith(LOCAL, { force: [EDITED_PATH] }))
  const update = await dialog.findByRole('button', { name: 'Update 1 skill' })
  await waitFor(() => expect(update.hasAttribute('disabled')).toBe(false))
  fireEvent.click(update)
  await waitFor(() =>
    expect(mocks.execute).toHaveBeenCalledWith(LOCAL, forcedPlan.planDigest, {
      force: [EDITED_PATH]
    })
  )
})

it('uses the active workspace for requests without an originating target', async () => {
  act(() => requestSkillFreshnessUpdateDialog())
  render(<SkillFreshnessUpdateDialog />)
  const dialog = within(screen.getByRole('dialog'))
  expect(dialog.getByText('orchestration')).toBeDefined()
  expect(dialog.queryByText('orca-cli')).toBeNull()
  fireEvent.click(dialog.getByRole('button', { name: 'Update 1 skill' }))
  await waitFor(() =>
    expect(mocks.execute).toHaveBeenCalledWith(REMOTE, remotePlan.planDigest, { force: [] })
  )
})
