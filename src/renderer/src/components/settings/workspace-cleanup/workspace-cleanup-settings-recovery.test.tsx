// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { I18nProvider } from '@/i18n/I18nProvider'
import { TooltipProvider } from '../../ui/tooltip'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import { getDefaultWorkspaceCleanupRules } from '../../../../../shared/workspace-cleanup/workspace-cleanup-policy'
import type { WorkspaceCleanupPolicyRead } from '../../../../../shared/workspace-cleanup/workspace-cleanup-policy-change'
import { RepositoryWorkspaceCleanupSection } from '../repository/workspace-cleanup/RepositoryWorkspaceCleanupSection'
import { WorkspaceCleanupSettingsPane } from './WorkspaceCleanupSettingsPane'
import * as hostRulesHook from './use-workspace-cleanup-host-rules'

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
let read: WorkspaceCleanupPolicyRead
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
      projects: [{ id: 'project', hostId: 'local', policy: repo.workspaceCleanupPolicy }]
    }
  }
  useAppStore.setState({
    settings: getDefaultSettings('/synthetic'),
    repos: [repo],
    settingsSearchQuery: ''
  })
  runtime.mockReset().mockImplementation(async ({ method, params }) => {
    if (method === 'workspaceCleanup.policyState') {
      return { ok: true, result: structuredClone(read) }
    }
    if (method === 'workspaceCleanup.reservePolicyWrite') {
      return { ok: true, result: { reserved: true } }
    }
    if (method === 'settings.update') {
      read.state.rules = params.workspaceCleanupPolicy
      return { ok: true, result: {} }
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

it('allows Off through a ready guarded write when the host-rules read failed', async () => {
  vi.spyOn(hostRulesHook, 'useWorkspaceCleanupHostRules').mockReturnValue({
    hostRules: { state: 'error', message: 'Host settings unavailable' },
    reload: () => {},
    readLatest: async () => null,
    update: async () => false
  })
  renderWithProviders(
    <RepositoryWorkspaceCleanupSection repo={repo} updateRepo={async () => true} forceVisible />
  )
  const control = await screen.findByRole('switch', { name: 'Delete merged workspaces' })
  await waitFor(() => expect(control.getAttribute('aria-disabled')).toBe('false'))
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' })
  fireEvent.click(await screen.findByRole('option', { name: 'Off' }))
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        updates: expect.objectContaining({ workspaceCleanupPolicy: { mode: 'off' } })
      })
    )
  )
})

it('keeps the Advanced rule and its retry reachable after its preview fails', async () => {
  const normal = runtime.getMockImplementation()!
  runtime.mockImplementation((request) =>
    request.method === 'workspaceCleanup.previewChange'
      ? Promise.reject(new Error('Preview unavailable'))
      : normal(request)
  )
  renderWithProviders(
    <RepositoryWorkspaceCleanupSection repo={repo} updateRepo={async () => true} forceVisible />
  )
  await waitFor(() =>
    expect(
      screen.getByRole('switch', { name: 'Delete merged workspaces' }).getAttribute('aria-disabled')
    ).toBe('false')
  )
  fireEvent.click(screen.getByRole('button', { name: /Advanced/ }))
  fireEvent.click(screen.getByRole('switch', { name: 'Delete finished automation workspaces' }))
  await screen.findByRole('alert')
  expect(screen.getByRole('switch', { name: 'Delete finished automation workspaces' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  await waitFor(() =>
    expect(
      runtime.mock.calls.filter(([request]) => request.method === 'workspaceCleanup.previewChange')
    ).toHaveLength(2)
  )
})

it('shows same-host settings changes and toggles the rule from its current state', async () => {
  read.state.repoId = null
  renderWithProviders(<GlobalSettingsPane />)
  await waitFor(() =>
    expect(
      screen.getByRole('switch', { name: 'Delete merged workspaces' }).getAttribute('aria-disabled')
    ).toBe('false')
  )
  read.state.rules = { ...rules, merged: { enabled: true } }
  act(() =>
    useAppStore.setState({
      settings: { ...getDefaultSettings('/synthetic'), workspaceCleanupPolicy: read.state.rules }
    })
  )
  const control = screen.getByRole('switch', { name: 'Delete merged workspaces' })
  expect(control.getAttribute('aria-checked')).toBe('true')
  fireEvent.click(control)
  await waitFor(() =>
    expect(runtime).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'settings.update',
        params: expect.objectContaining({
          workspaceCleanupPolicy: expect.objectContaining({ merged: { enabled: false } })
        })
      })
    )
  )
  expect(screen.queryByRole('dialog')).toBeNull()
})
