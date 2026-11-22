import { createWorkspaceCleanupPolicyWrite } from './workspace-cleanup-policy-client'
import { TooltipProvider } from '../../ui/tooltip'
// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { I18nProvider } from '@/i18n/I18nProvider'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import { getDefaultWorkspaceCleanupRules } from '../../../../../shared/workspace-cleanup/workspace-cleanup-policy'
import { RepositoryWorkspaceCleanupSection } from '../repository/workspace-cleanup/RepositoryWorkspaceCleanupSection'
import type { WorkspaceCleanupPreviewRow } from '../../../../../shared/workspace-cleanup/workspace-cleanup-run'
import type { WorkspaceCleanupPolicyRead } from '../../../../../shared/workspace-cleanup/workspace-cleanup-policy-change'
import { useWorkspaceCleanupRuleChange } from './use-workspace-cleanup-rule-change'
import { WorkspaceCleanupSettingsPane } from './WorkspaceCleanupSettingsPane'
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

it('keeps focus inside the confirmation when its save fails', async () => {
  save.mockRejectedValueOnce(new Error('Write refused'))
  const normal = runtime.getMockImplementation()!
  runtime.mockImplementation(async (request) =>
    request.method === 'workspaceCleanup.settlePolicyWrite'
      ? { ok: true, result: { outcome: 'cancelled' } }
      : normal(request)
  )
  await open()
  fireEvent.click(screen.getByRole('button', { name: 'Turn on' }))
  await waitFor(() => {
    const dialog = screen.getByRole('dialog')
    expect(dialog.contains(document.activeElement)).toBe(true)
    expect(screen.getByRole('alert').contains(document.activeElement)).toBe(true)
  })
  expect(read.state.projects[0].policy).toMatchObject({ rules: { merged: { enabled: false } } })
})
function Harness({ global = false }: { global?: boolean }) {
  const change = useWorkspaceCleanupRuleChange({
    owner: { kind: 'local' },
    repoId: global ? null : 'project',
    projectName: global ? undefined : 'Example'
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
function GlobalSettingsPane() {
  const settings = useAppStore((state) => state.settings)
  return (
    <WorkspaceCleanupSettingsPane
      hostScope={{ target: { kind: 'local' }, available: true }}
      settings={settings}
      updateSettings={() => {}}
    />
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
it('shows a red confirm while it deletes anything, and a normal one once everything is kept', async () => {
  await open()
  const confirm = screen.getByRole('button', { name: 'Turn on' })
  expect(confirm.getAttribute('data-variant')).toBe('destructive')
  fireEvent.click(screen.getByRole('checkbox', { name: 'Keep existing' }))
  expect(confirm.getAttribute('data-variant')).toBe('destructive')
  fireEvent.click(screen.getByRole('checkbox', { name: 'Keep added' }))
  await waitFor(() => expect(confirm.getAttribute('data-variant')).toBe('default'))
})
it('offers Keep for the complete proposed set and does not activate on cancel', async () => {
  await open()
  expect(screen.getByRole('checkbox', { name: 'Keep existing' })).toBeTruthy()
  expect(screen.getByRole('checkbox', { name: 'Keep added' })).toBeTruthy()
  expect(read.state.projects[0].policy).toMatchObject({
    mode: 'custom',
    rules: { merged: { enabled: false } }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(read.state.projects[0].policy).toMatchObject({
    mode: 'custom',
    rules: { merged: { enabled: false } }
  })
})
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
it('keeps old-host rule controls focusable and refuses a rule toggle', async () => {
  const updateRepo = vi.fn(async () => true)
  runtime.mockResolvedValue({
    ok: false,
    error: { code: 'method_not_found', message: 'Unknown method' }
  })
  const staleRepo = {
    ...repo,
    workspaceCleanupPolicy: {
      mode: 'custom' as const,
      rules: {
        ...rules,
        merged: { enabled: true },
        inactive: { enabled: true, afterDays: 30, action: 'delete' as const }
      }
    }
  }
  useAppStore.setState({
    repos: [
      {
        ...staleRepo,
        workspaceCleanupPolicy: {
          mode: 'custom',
          rules: {
            ...staleRepo.workspaceCleanupPolicy.rules,
            inactive: { ...staleRepo.workspaceCleanupPolicy.rules.inactive, enabled: false }
          }
        }
      }
    ]
  })
  renderWithProviders(
    <RepositoryWorkspaceCleanupSection repo={staleRepo} updateRepo={updateRepo} forceVisible />
  )
  const control = await screen.findByRole('switch', { name: 'Delete merged workspaces' })
  await screen.findByText('Update Orca on this host to change rules. Off still works.')
  await waitFor(() => expect(control.getAttribute('aria-disabled')).toBe('true'))
  expect(control.hasAttribute('disabled')).toBe(false)
  fireEvent.click(control)
  expect(
    runtime.mock.calls.some(([request]) =>
      [
        'workspaceCleanup.previewChange',
        'workspaceCleanup.reservePolicyWrite',
        'settings.update'
      ].includes(request.method)
    )
  ).toBe(false)
  expect(save).not.toHaveBeenCalled()
  expect(updateRepo).not.toHaveBeenCalled()
})

it('keeps the header match count factual when every reviewed workspace is kept', async () => {
  await open()
  fireEvent.click(screen.getByRole('checkbox', { name: 'Keep existing' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Keep added' }))
  const dialog = screen.getByRole('dialog')
  const description = document.getElementById(dialog.getAttribute('aria-describedby')!)!
  expect(description.textContent).toBe('2 workspaces match right now.')
  expect(screen.getByText(/0 will be deleted/)).toBeTruthy()
})
it('routes the actual project switch through confirmation before saving', async () => {
  renderWithProviders(
    <RepositoryWorkspaceCleanupSection repo={repo} updateRepo={async () => true} forceVisible />
  )
  const control = await screen.findByRole('switch', { name: 'Delete merged workspaces' })
  await waitFor(() => expect(control.getAttribute('aria-disabled')).toBe('false'))
  fireEvent.click(control)
  await screen.findByRole('dialog')
  expect(read.state.projects[0].policy).toMatchObject({
    mode: 'custom',
    rules: { merged: { enabled: false } }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Turn on' }))
  await waitFor(() =>
    expect(read.state.projects[0].policy).toMatchObject({
      mode: 'custom',
      rules: { merged: { enabled: true } }
    })
  )
})
it('settles an applied write whose acknowledgement was lost without resubmitting it', async () => {
  const normal = runtime.getMockImplementation()!
  runtime.mockImplementation(async (request) =>
    request.method === 'workspaceCleanup.settlePolicyWrite'
      ? { ok: true, result: { outcome: 'applied' } }
      : normal(request)
  )
  save.mockImplementationOnce(async ({ updates }) => {
    read.state.projects[0].policy = updates.workspaceCleanupPolicy
    throw new Error('Reply lost')
  })
  await open()
  fireEvent.click(screen.getByRole('button', { name: 'Turn on' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(read.state.projects[0].policy).toMatchObject({
    mode: 'custom',
    rules: { merged: { enabled: true } }
  })
})

it('routes the actual global switch through the same full-set confirmation', async () => {
  read.state.repoId = null
  read.state.projects[0].policy = null
  renderWithProviders(<GlobalSettingsPane />)
  const control = await screen.findByRole('switch', { name: 'Delete merged workspaces' })
  await waitFor(() => expect(control.getAttribute('aria-disabled')).toBe('false'))
  fireEvent.click(control)
  await screen.findByRole('dialog')
  expect(screen.getByRole('checkbox', { name: 'Keep existing' })).toBeTruthy()
  expect(read.state.rules.merged.enabled).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(read.state.rules.merged.enabled).toBe(false)
})
it('reads back a durable Keep after its reply is lost before activating the policy', async () => {
  const normal = runtime.getMockImplementation()!
  runtime.mockImplementation(async (request) => {
    if (request.method === 'workspaceCleanup.pinBatch') {
      pin.push(...request.params.rows.map((item: { worktreeId: string }) => item.worktreeId))
      throw new Error('Reply lost')
    }
    if (request.method === 'workspaceCleanup.inspectKept') {
      return { ok: true, result: { deleted: [], pinned: [...pin] } }
    }
    return normal(request)
  })
  await open()
  fireEvent.click(screen.getByRole('checkbox', { name: 'Keep existing' }))
  fireEvent.click(screen.getByRole('button', { name: 'Turn on' }))
  await waitFor(() =>
    expect(read.state.projects[0].policy).toMatchObject({
      mode: 'custom',
      rules: { merged: { enabled: true } }
    })
  )
})
it('restores the saved inactive threshold when its edit is cancelled', async () => {
  read.state.projects[0].policy = {
    mode: 'custom',
    rules: { ...rules, inactive: { enabled: true, afterDays: 90, action: 'delete' } }
  }
  renderWithProviders(
    <RepositoryWorkspaceCleanupSection repo={repo} updateRepo={async () => true} forceVisible />
  )
  const input = await screen.findByRole('spinbutton', { name: 'Inactive for' })
  await waitFor(() => expect(input.getAttribute('aria-disabled')).not.toBe('true'))
  fireEvent.focus(input)
  fireEvent.change(input, { target: { value: '1' } })
  fireEvent.blur(input)
  await screen.findByRole('dialog')
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  await waitFor(() => {
    const restored = screen.getByRole('spinbutton', { name: 'Inactive for' })
    if (!(restored instanceof HTMLInputElement)) {
      throw new Error('Expected number input')
    }
    expect(restored.value).toBe('90')
  })
  expect(read.state.projects[0].policy).toMatchObject({
    mode: 'custom',
    rules: { inactive: { afterDays: 90 } }
  })
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

it('retains confirmed global matches and excludes durable Keep when a background preview is unavailable', async () => {
  read.state.repoId = null
  read.state.projects[0].policy = null
  const normal = runtime.getMockImplementation()!
  runtime.mockImplementation(async (request) => {
    if (request.method === 'settings.update') {
      read.state.rules = request.params.workspaceCleanupPolicy
      return { ok: true, result: {} }
    }
    if (request.method === 'workspaceCleanup.preview') {
      throw new Error('Background preview unavailable')
    }
    if (request.method === 'workspaceCleanup.report') {
      return { ok: true, result: { runs: [], running: false, nextRunAt: null } }
    }
    return normal(request)
  })
  renderWithProviders(<GlobalSettingsPane />)
  const control = await screen.findByRole('switch', { name: 'Delete merged workspaces' })
  await waitFor(() => expect(control.getAttribute('aria-disabled')).toBe('false'))
  fireEvent.click(control)
  await screen.findByRole('dialog')
  fireEvent.click(screen.getByRole('checkbox', { name: 'Keep existing' }))
  fireEvent.click(screen.getByRole('button', { name: 'Turn on' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(read.state.rules.merged.enabled).toBe(true)
  expect(pin).toEqual(['project::/existing'])
  expect(screen.getByText(/^Matches 1 workspace now/)).toBeTruthy()
})

it.each([
  ['project', 'zero-delta'],
  ['global', 'zero-delta'],
  ['project', 'confirmation'],
  ['global', 'confirmation']
] as const)(
  'preserves a concurrent edit in the %s %s preview interleaving',
  async (scope, phase) => {
    const active = {
      ...rules,
      inactive: { enabled: true, afterDays: 30, action: 'delete' as const }
    }
    if (scope === 'global') {
      read.state.repoId = null
      read.state.projects[0].policy = null
      read.state.rules = active
    } else {
      read.state.projects[0].policy = { mode: 'custom', rules: active }
    }
    currentRows = []
    nextRows = phase === 'zero-delta' ? [] : [row('added')]
    const normal = runtime.getMockImplementation()!
    let interleave = phase === 'zero-delta'
    runtime.mockImplementation(async (request) => {
      if (request.method === 'workspaceCleanup.previewChange' && interleave) {
        interleave = false
        const newer = { ...active, inactive: { ...active.inactive, enabled: false } }
        if (scope === 'global') {
          read.state.rules = newer
        } else {
          read.state.projects[0].policy = { mode: 'custom', rules: newer }
        }
      }
      return normal(request)
    })
    renderWithProviders(<Harness global={scope === 'global'} />)
    const trigger = screen.getByRole('button', { name: 'Enable' })
    await waitFor(() => expect(trigger.getAttribute('aria-disabled')).toBe('false'))
    fireEvent.click(trigger)
    if (phase === 'confirmation') {
      await screen.findByRole('dialog')
      interleave = true
      fireEvent.click(screen.getByRole('button', { name: 'Turn on' }))
      await screen.findByRole('alert')
    } else {
      await waitFor(() => expect(trigger.getAttribute('aria-disabled')).toBe('false'))
    }
    const saved = scope === 'global' ? read.state.rules : read.state.projects[0].policy
    expect(saved).toMatchObject(
      scope === 'global'
        ? { merged: { enabled: false }, inactive: { enabled: false } }
        : { mode: 'custom', rules: { merged: { enabled: false }, inactive: { enabled: false } } }
    )
  }
)

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

it('keeps an applied write with a lost reply tracked while a remounted page checks its receipt', async () => {
  const applied = Promise.withResolvers<void>()
  const reply = Promise.withResolvers<void>()
  const receipt = Promise.withResolvers<void>()
  const normal = runtime.getMockImplementation()!
  runtime.mockImplementation(async (request) => {
    if (request.method === 'workspaceCleanup.settlePolicyWrite') {
      await receipt.promise
      return { ok: true, result: { outcome: 'applied' } }
    }
    return normal(request)
  })
  save.mockImplementationOnce(async ({ updates }) => {
    read.state.projects[0].policy = updates.workspaceCleanupPolicy
    applied.resolve()
    await reply.promise
    throw new Error('Reply lost')
  })
  await open()
  fireEvent.click(screen.getByRole('button', { name: 'Turn on' }))
  await applied.promise
  cleanup()
  renderWithProviders(
    <RepositoryWorkspaceCleanupSection repo={repo} updateRepo={async () => true} forceVisible />
  )
  const control = await screen.findByRole('switch', { name: 'Delete merged workspaces' })
  expect(control.getAttribute('aria-disabled')).toBe('true')
  await act(async () => receipt.resolve())
  await waitFor(() => expect(control.getAttribute('aria-disabled')).toBe('false'))
  expect(control.getAttribute('aria-checked')).toBe('true')
  await act(async () => reply.resolve())
  expect(read.state.projects[0].policy).toMatchObject({
    mode: 'custom',
    rules: { merged: { enabled: true } }
  })
})

it('recovers an owner reservation when a new view has no local request tracker', async () => {
  const recovery = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  const normal = runtime.getMockImplementation()!
  runtime.mockImplementation(async (request) => {
    if (request.method === 'workspaceCleanup.policyState') {
      return { ok: true, result: { ...structuredClone(read), pendingWrites: true } }
    }
    if (request.method === 'workspaceCleanup.recoverPolicyWrites') {
      entered.resolve()
      await recovery.promise
      return { ok: true, result: { ...structuredClone(read), pendingWrites: false } }
    }
    return normal(request)
  })
  renderWithProviders(
    <RepositoryWorkspaceCleanupSection repo={repo} updateRepo={async () => true} forceVisible />
  )
  await entered.promise
  const control = screen.getByRole('switch', { name: 'Delete merged workspaces' })
  expect(control.getAttribute('aria-disabled')).toBe('true')
  fireEvent.click(control)
  expect(read.state.projects[0].policy).toMatchObject({
    mode: 'custom',
    rules: { merged: { enabled: false } }
  })
  await act(async () => recovery.resolve())
  await waitFor(() => expect(control.getAttribute('aria-disabled')).toBe('false'))
  expect(control.getAttribute('aria-checked')).toBe('false')
})

it('fences a journaled reservation that has not arrived when a new view opens', async () => {
  const released = Promise.withResolvers<void>()
  const sent = Promise.withResolvers<void>()
  const fenced = new Set<string>()
  const normal = runtime.getMockImplementation()!
  runtime.mockImplementation(async (request) => {
    if (request.method === 'workspaceCleanup.reservePolicyWrite') {
      sent.resolve()
      await released.promise
      if (fenced.has(request.params.id)) {
        throw new Error('workspace_cleanup_policy_conflict')
      }
      return { ok: true, result: { reserved: true } }
    }
    if (request.method === 'workspaceCleanup.settlePolicyWrite') {
      fenced.add(request.params.id)
      return { ok: true, result: { outcome: 'cancelled' } }
    }
    if (request.method === 'workspaceCleanup.recoverPolicyWrites') {
      return { ok: true, result: { ...structuredClone(read), pendingWrites: false } }
    }
    return normal(request)
  })
  const previousClient = createWorkspaceCleanupPolicyWrite(
    { kind: 'local' },
    {
      scope: 'project',
      repoId: 'project',
      policy: { mode: 'custom', rules: { ...rules, merged: { enabled: true } } }
    },
    structuredClone(read)
  )
  const late = previousClient.send()
  const rejected = expect(late).rejects.toThrow('workspace_cleanup_policy_conflict')
  await sent.promise
  renderWithProviders(<Harness />)
  const trigger = screen.getByRole('button', { name: 'Enable' })
  await waitFor(() => expect(trigger.getAttribute('aria-disabled')).toBe('false'))
  await act(async () => released.resolve())
  await rejected
  expect(read.state.projects[0].policy).toMatchObject({
    mode: 'custom',
    rules: { merged: { enabled: false } }
  })
})

it('releases the owner barrier after a fenced request target is removed', async () => {
  const sent = Promise.withResolvers<void>()
  const late = Promise.withResolvers<void>()
  const fenced = Promise.withResolvers<void>()
  const normal = runtime.getMockImplementation()!
  runtime.mockImplementation(async (request) => {
    if (request.method === 'workspaceCleanup.settlePolicyWrite') {
      await fenced.promise
      return { ok: true, result: { outcome: 'cancelled' } }
    }
    if (request.method === 'workspaceCleanup.policyState' && !read.state.projects.length) {
      if (request.params.repoId) {
        throw new Error('workspace_cleanup_project_unavailable')
      }
      return {
        ok: true,
        result: { ...structuredClone(read), state: { ...read.state, repoId: null } }
      }
    }
    return normal(request)
  })
  save.mockImplementationOnce(async () => {
    sent.resolve()
    await late.promise
    throw new Error('workspace_cleanup_project_unavailable')
  })
  await open()
  fireEvent.click(screen.getByRole('button', { name: 'Turn on' }))
  await sent.promise
  cleanup()
  read.state.projects = []
  renderWithProviders(<Harness global />)
  const trigger = screen.getByRole('button', { name: 'Enable' })
  expect(trigger.getAttribute('aria-disabled')).toBe('true')
  await act(async () => fenced.resolve())
  await waitFor(() => expect(trigger.getAttribute('aria-disabled')).toBe('false'))
  expect(read.state.rules.merged.enabled).toBe(false)
  await act(async () => late.resolve())
})

it('keeps two selected rows durable after a lost batch reply before saving the rule', async () => {
  const normal = runtime.getMockImplementation()!
  runtime.mockImplementation(async (request) => {
    if (request.method === 'workspaceCleanup.pinBatch') {
      await normal(request)
      throw new Error('Batch reply lost')
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
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(pin).toEqual(['project::/existing', 'project::/added'])
  expect(read.state.projects[0].policy).toMatchObject({
    mode: 'custom',
    rules: { merged: { enabled: true } }
  })
})
it('retains partial batch pins and leaves the policy unchanged until every Keep is proved', async () => {
  const normal = runtime.getMockImplementation()!
  runtime.mockImplementation(async (request) => {
    if (request.method === 'workspaceCleanup.pinBatch') {
      pin.push('project::/existing')
      return {
        ok: true,
        result: { pinned: ['project::/existing'], deleted: [], failed: ['project::/added'] }
      }
    }
    if (request.method === 'workspaceCleanup.inspectKept') {
      return { ok: true, result: { pinned: ['project::/existing'], deleted: [] } }
    }
    return normal(request)
  })
  await open()
  fireEvent.click(screen.getByRole('checkbox', { name: 'Keep existing' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Keep added' }))
  fireEvent.click(screen.getByRole('button', { name: 'Turn on' }))
  await screen.findByRole('alert')
  expect(pin).toEqual(['project::/existing'])
  expect(read.state.projects[0].policy).toMatchObject({
    mode: 'custom',
    rules: { merged: { enabled: false } }
  })
})
