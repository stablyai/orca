import { TooltipProvider } from '../../ui/tooltip'
// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { I18nProvider } from '@/i18n/I18nProvider'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import { getDefaultWorkspaceCleanupRules } from '../../../../../shared/workspace-cleanup/workspace-cleanup-policy'
import type { WorkspaceCleanupPreviewRow } from '../../../../../shared/workspace-cleanup/workspace-cleanup-run'
import type { WorkspaceCleanupPolicyRead } from '../../../../../shared/workspace-cleanup/workspace-cleanup-policy-change'
import { useWorkspaceCleanupRuleChange } from './use-workspace-cleanup-rule-change'
import { WorkspaceCleanupRuleChangeDialog } from './workspace-cleanup-rule-change-dialog'

const api = window.api
const original = useAppStore.getState()
const rules = getDefaultWorkspaceCleanupRules()
const repo = {
  id: 'project',
  path: '/synthetic/project',
  displayName: 'Example',
  badgeColor: 'gray',
  addedAt: 1,
  workspaceCleanupPolicy: { mode: 'custom' as const, rules }
}
const row = (id: string): WorkspaceCleanupPreviewRow => ({
  worktreeId: `project::/${id}`,
  instanceId: id,
  repoId: 'project',
  repoName: 'Example',
  displayName: id,
  path: `/${id}`,
  branch: id,
  executionHostId: 'local',
  evaluation: { action: 'delete', reason: 'merged' }
})
let read: WorkspaceCleanupPolicyRead
let nextRows: WorkspaceCleanupPreviewRow[]
let currentRows: WorkspaceCleanupPreviewRow[]
let pin: string[]
const runtime = vi.fn()
const save = vi.fn()
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 10, 14, 12))
  read = {
    protocol: 3,
    expiresAt: Date.UTC(2026, 10, 14, 12, 1),
    state: {
      repoId: 'project',
      rules,
      projects: [{ id: 'project', hostId: 'local', policy: { mode: 'custom', rules } }]
    }
  }
  currentRows = [row('existing')]
  nextRows = [row('existing'), row('added')]
  pin = []
  useAppStore.setState({
    settings: getDefaultSettings('/synthetic'),
    repos: [repo],
    settingsSearchQuery: ''
  })
  runtime.mockReset().mockImplementation(async ({ method, params }) => {
    if (method === 'workspaceCleanup.policyState') {
      return { ok: true, result: structuredClone(read) }
    }
    if (method === 'workspaceCleanup.previewChange') {
      return {
        ok: true,
        result: {
          read: structuredClone(read),
          current: { evaluatedAt: 1, rows: structuredClone(currentRows) },
          next: { evaluatedAt: 1, rows: structuredClone(nextRows) }
        }
      }
    }
    if (method === 'workspaceCleanup.reservePolicyWrite') {
      return { ok: true, result: { reserved: true } }
    }
    if (method === 'settings.update') {
      read.state.rules = params.workspaceCleanupPolicy
      return { ok: true, result: {} }
    }
    if (method === 'workspaceCleanup.settlePolicyWrite') {
      return { ok: true, result: { outcome: 'applied' } }
    }
    if (method === 'workspaceCleanup.pinBatch') {
      pin.push(...params.rows.map((row: { worktreeId: string }) => row.worktreeId))
      return {
        ok: true,
        result: {
          pinned: params.rows.map((row: { worktreeId: string }) => row.worktreeId),
          deleted: [],
          failed: []
        }
      }
    }
    if (method === 'workspaceCleanup.inspectKept') {
      return {
        ok: true,
        result: { deleted: params.rows.map((item: { worktreeId: string }) => item.worktreeId) }
      }
    }
    throw new Error(`Unexpected RPC ${method}`)
  })
  save.mockReset().mockImplementation(async ({ updates }) => {
    read.state.projects[0].policy = updates.workspaceCleanupPolicy
    return { ...repo, workspaceCleanupPolicy: updates.workspaceCleanupPolicy }
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      ...api,
      runtime: { ...api?.runtime, call: runtime },
      repos: { ...api?.repos, update: save }
    }
  })
})
afterEach(() => {
  cleanup()
  useAppStore.setState(original, true)
  Object.defineProperty(window, 'api', { configurable: true, value: api })
  vi.restoreAllMocks()
})

function Harness() {
  const change = useWorkspaceCleanupRuleChange({
    owner: { kind: 'local' },
    repoId: 'project',
    projectName: 'Example'
  })
  return (
    <>
      <button
        aria-label="Enable"
        aria-disabled={change.guarded}
        onClick={() =>
          change.requestChange({
            setting: 'merged',
            kind: 'enable',
            changeRules: (latest) => ({ ...latest, merged: { enabled: true } })
          })
        }
      >
        Enable
      </button>
      <WorkspaceCleanupRuleChangeDialog
        request={change.pending}
        onConfirm={change.confirm}
        onCancel={change.cancel}
        onToggleKeep={change.toggleKeep}
        confirming={change.saving}
        error={change.error}
      />
    </>
  )
}
function renderWithProviders(view: React.ReactNode) {
  return render(
    <TooltipProvider>
      <I18nProvider>{view}</I18nProvider>
    </TooltipProvider>
  )
}
async function open() {
  renderWithProviders(<Harness />)
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Enable' }).getAttribute('aria-disabled')).toBe(
      'false'
    )
  )
  fireEvent.click(screen.getByRole('button', { name: 'Enable' }))
  await screen.findByRole('dialog')
}

it('preserves Keep on refresh, then pins it before the policy is activated', async () => {
  await open()
  fireEvent.click(screen.getByRole('checkbox', { name: 'Keep existing' }))
  nextRows.push(row('late'))
  fireEvent.click(screen.getByRole('button', { name: 'Turn on' }))
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('status')))
  expect(screen.getByRole('checkbox', { name: 'Keep existing' }).getAttribute('data-state')).toBe(
    'checked'
  )
  expect(screen.getByRole('checkbox', { name: 'Keep late' })).toBeTruthy()
  expect(read.state.projects[0].policy).toMatchObject({
    mode: 'custom',
    rules: { merged: { enabled: false } }
  })
  save.mockImplementationOnce(async ({ updates }) => {
    expect(pin).toEqual(['project::/existing'])
    read.state.projects[0].policy = updates.workspaceCleanupPolicy
    return { ...repo, workspaceCleanupPolicy: updates.workspaceCleanupPolicy }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Turn on' }))
  await waitFor(() =>
    expect(read.state.projects[0].policy).toMatchObject({
      mode: 'custom',
      rules: { merged: { enabled: true } }
    })
  )
})
it('blocks the first confirm when a kept incarnation was deleted', async () => {
  await open()
  fireEvent.click(screen.getByRole('checkbox', { name: 'Keep existing' }))
  nextRows = [row('added')]
  currentRows = []
  fireEvent.click(screen.getByRole('button', { name: 'Turn on' }))
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('status')))
  expect(read.state.projects[0].policy).toMatchObject({
    mode: 'custom',
    rules: { merged: { enabled: false } }
  })
  expect(screen.queryByRole('checkbox', { name: 'Keep existing' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Turn on' }))
  await waitFor(() =>
    expect(read.state.projects[0].policy).toMatchObject({
      mode: 'custom',
      rules: { merged: { enabled: true } }
    })
  )
})

it('cancels a zero-delta activation when navigation retires its deferred preview', async () => {
  const pending = Promise.withResolvers<unknown>()
  const sent = Promise.withResolvers<void>()
  const normal = runtime.getMockImplementation()!
  runtime.mockImplementation((request) => {
    if (request.method !== 'workspaceCleanup.previewChange') {
      return normal(request)
    }
    sent.resolve()
    return pending.promise
  })
  renderWithProviders(<Harness />)
  const control = screen.getByRole('button', { name: 'Enable' })
  await waitFor(() => expect(control.getAttribute('aria-disabled')).toBe('false'))
  fireEvent.click(control)
  // Unmount only once the preview is actually pending, as navigation would find it.
  await act(() => sent.promise)
  cleanup()
  await act(async () => {
    pending.resolve({
      ok: true,
      result: {
        read: structuredClone(read),
        current: { evaluatedAt: 1, rows: [] },
        next: { evaluatedAt: 1, rows: [] }
      }
    })
    await pending.promise
  })
  expect(read.state.projects[0].policy).toMatchObject({
    mode: 'custom',
    rules: { merged: { enabled: false } }
  })
})

it('fences a deferred send across unmount and remount before allowing another change', async () => {
  const sent = Promise.withResolvers<void>()
  const late = Promise.withResolvers<void>()
  const fenced = Promise.withResolvers<void>()
  const finished = Promise.withResolvers<void>()
  const cancelled = new Set<string>()
  const normal = runtime.getMockImplementation()!
  runtime.mockImplementation(async (request) => {
    if (request.method === 'workspaceCleanup.settlePolicyWrite') {
      await fenced.promise
      cancelled.add(request.params.id)
      return { ok: true, result: { outcome: 'cancelled' } }
    }
    return normal(request)
  })
  save.mockImplementationOnce(async ({ updates }) => {
    sent.resolve()
    await late.promise
    try {
      if (cancelled.has(updates.workspaceCleanupGuard.id)) {
        throw new Error('workspace_cleanup_policy_conflict')
      }
      read.state.projects[0].policy = updates.workspaceCleanupPolicy
      return { ...repo, workspaceCleanupPolicy: updates.workspaceCleanupPolicy }
    } finally {
      finished.resolve()
    }
  })
  await open()
  fireEvent.click(screen.getByRole('button', { name: 'Turn on' }))
  await sent.promise
  cleanup()
  renderWithProviders(<Harness />)
  const trigger = screen.getByRole('button', { name: 'Enable' })
  expect(trigger.getAttribute('aria-disabled')).toBe('true')
  fireEvent.click(trigger)
  expect(read.state.projects[0].policy).toMatchObject({
    mode: 'custom',
    rules: { merged: { enabled: false } }
  })
  await act(async () => fenced.resolve())
  await waitFor(() => expect(trigger.getAttribute('aria-disabled')).toBe('false'))
  await act(async () => {
    late.resolve()
    await finished.promise
  })
  expect(read.state.projects[0].policy).toMatchObject({
    mode: 'custom',
    rules: { merged: { enabled: false } }
  })
})

it.each([
  { reply: 'lost', proved: ['project::/existing', 'project::/added'] },
  { reply: 'partial', proved: ['project::/existing'] }
])(
  'saves the rule only once every Keep is proved durable ($reply batch reply)',
  async ({ reply, proved }) => {
    const normal = runtime.getMockImplementation()!
    runtime.mockImplementation(async (request) => {
      if (request.method === 'workspaceCleanup.pinBatch') {
        pin.push(...proved)
        if (reply === 'lost') {
          throw new Error('Batch reply lost')
        }
        return {
          ok: true,
          result: { pinned: proved, deleted: [], failed: ['project::/added'] }
        }
      }
      if (request.method === 'workspaceCleanup.inspectKept') {
        return { ok: true, result: { deleted: [], pinned: [...pin] } }
      }
      return normal(request)
    })
    await open()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Keep existing' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Keep added' }))
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }))
    await (reply === 'partial'
      ? screen.findByRole('alert')
      : waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()))
    expect(pin).toEqual(proved)
    expect(read.state.projects[0].policy).toMatchObject({
      mode: 'custom',
      rules: { merged: { enabled: reply === 'lost' } }
    })
  }
)
