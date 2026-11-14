import { TooltipProvider } from '../../ui/tooltip'
// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { I18nProvider } from '@/i18n/I18nProvider'
import { getDefaultSettings } from '../../../../../shared/constants'
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
    protocol: 1,
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
    if (method === 'workspaceCleanup.pin') {
      pin.push(params.worktreeId)
      return { ok: true, result: { pinned: true } }
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
    <RepositoryWorkspaceCleanupSection
      repo={staleRepo}
      updateRepo={async () => true}
      forceVisible
    />
  )
  const control = await screen.findByRole('switch', { name: 'Delete merged workspaces' })
  await waitFor(() => expect(control.getAttribute('aria-disabled')).toBe('true'))
  expect(control.hasAttribute('disabled')).toBe(false)
  fireEvent.click(control)
  expect(useAppStore.getState().repos[0].workspaceCleanupPolicy).toMatchObject({
    mode: 'custom',
    rules: { merged: { enabled: true }, inactive: { enabled: false } }
  })
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
  renderWithProviders(
    <WorkspaceCleanupSettingsPane
      hostScope={{ target: { kind: 'local' }, available: true }}
      settings={getDefaultSettings('/synthetic')}
      updateSettings={() => {}}
    />
  )
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
    if (request.method === 'workspaceCleanup.pin') {
      pin.push(request.params.worktreeId)
      throw new Error('Reply lost')
    }
    if (request.method === 'workspaceCleanup.inspectKept') {
      return { ok: true, result: { deleted: [], pinned: ['project::/existing'] } }
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
  const normal = runtime.getMockImplementation()!
  runtime.mockImplementation((request) =>
    request.method === 'workspaceCleanup.previewChange' ? pending.promise : normal(request)
  )
  renderWithProviders(<Harness />)
  const control = screen.getByRole('button', { name: 'Enable' })
  await waitFor(() => expect(control.getAttribute('aria-disabled')).toBe('false'))
  fireEvent.click(control)
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
  renderWithProviders(
    <WorkspaceCleanupSettingsPane
      hostScope={{ target: { kind: 'local' }, available: true }}
      settings={getDefaultSettings('/synthetic')}
      updateSettings={() => {}}
    />
  )
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
