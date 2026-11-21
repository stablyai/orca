// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { I18nProvider } from '@/i18n/I18nProvider'
import { notifyHostSettingsChanged } from '@/runtime/rpc/subscriptions/host-settings-changed'
import { TooltipProvider } from '../../ui/tooltip'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import {
  getDefaultWorkspaceCleanupRules,
  type WorkspaceCleanupRules
} from '../../../../../shared/workspace-cleanup/workspace-cleanup-policy'
import { WorkspaceCleanupSettingsPane } from './WorkspaceCleanupSettingsPane'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: rpc }))

const original = useAppStore.getState()
const ENVIRONMENT = 'env-1'
let hostRules: WorkspaceCleanupRules
/** Answers held for the next calls of a method, in call order; other calls answer at once. */
let held: Record<string, Promise<unknown>[]>

function policyRead(rules: WorkspaceCleanupRules) {
  return {
    protocol: 3,
    expiresAt: Date.UTC(2026, 10, 14, 12, 1),
    state: { repoId: null, rules: structuredClone(rules), projects: [] }
  }
}
function hold(method: string) {
  const answer = Promise.withResolvers<unknown>()
  answer.promise.catch(() => {})
  ;(held[method] ??= []).push(answer.promise)
  return answer
}
function calls(method: string): number {
  return rpc.mock.calls.filter(([, called]) => called === method).length
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 10, 14, 12))
  hostRules = getDefaultWorkspaceCleanupRules()
  held = {}
  useAppStore.setState({ settings: getDefaultSettings('/synthetic'), settingsSearchQuery: '' })
  rpc.mockReset().mockImplementation(async (_target, method: string, params) => {
    const answer = held[method]?.shift()
    if (answer) {
      return answer
    }
    switch (method) {
      case 'settings.get':
        return { settings: { workspaceCleanupPolicy: structuredClone(hostRules) } }
      case 'workspaceCleanup.policyState':
        return policyRead(hostRules)
      case 'workspaceCleanup.reservePolicyWrite':
        return { reserved: true }
      case 'settings.update':
        hostRules = params.workspaceCleanupPolicy
        return { settings: { workspaceCleanupPolicy: hostRules } }
      default:
        // Report and preview reads are not under test; leave them pending.
        return new Promise(() => {})
    }
  })
})
afterEach(() => {
  cleanup()
  useAppStore.setState(original, true)
  vi.restoreAllMocks()
})

function renderPane(): void {
  render(
    <TooltipProvider>
      <I18nProvider>
        <WorkspaceCleanupSettingsPane
          hostScope={{
            target: { kind: 'environment', environmentId: ENVIRONMENT },
            available: true
          }}
          settings={useAppStore.getState().settings}
          updateSettings={() => {}}
        />
      </I18nProvider>
    </TooltipProvider>
  )
}
const control = (): HTMLElement => screen.getByRole('switch', { name: 'Delete merged workspaces' })
const announce = (): void =>
  act(() => notifyHostSettingsChanged(ENVIRONMENT, ['workspaceCleanupPolicy']))

it("shows another client's change to the host's rules and toggles from it", async () => {
  renderPane()
  await waitFor(() => expect(control().getAttribute('aria-disabled')).toBe('false'))
  expect(control().getAttribute('aria-checked')).toBe('false')

  // Another client turns the rule on; the host announces it on its event stream.
  hostRules = { ...hostRules, merged: { enabled: true } }
  act(() => notifyHostSettingsChanged('another-host', ['workspaceCleanupPolicy']))
  act(() => notifyHostSettingsChanged(ENVIRONMENT, ['prAutoRefresh']))
  expect(control().getAttribute('aria-checked')).toBe('false')
  announce()
  await waitFor(() => expect(control().getAttribute('aria-checked')).toBe('true'))

  fireEvent.click(control())
  await waitFor(() =>
    expect(rpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: ENVIRONMENT },
      'settings.update',
      expect.objectContaining({
        workspaceCleanupPolicy: expect.objectContaining({ merged: { enabled: false } })
      })
    )
  )
})

it('keeps the newest of two overlapping refreshes', async () => {
  renderPane()
  await waitFor(() => expect(control().getAttribute('aria-disabled')).toBe('false'))
  const older = hold('workspaceCleanup.policyState')
  const newer = hold('workspaceCleanup.policyState')
  announce()
  announce()
  await waitFor(() => expect(calls('workspaceCleanup.policyState')).toBe(3))
  await act(async () => newer.resolve(policyRead({ ...hostRules, merged: { enabled: true } })))
  await waitFor(() => expect(control().getAttribute('aria-checked')).toBe('true'))
  await act(async () => older.resolve(policyRead(hostRules)))
  expect(control().getAttribute('aria-checked')).toBe('true')
})

it('enables the rules once a refresh reads the host after the first read failed', async () => {
  hold('workspaceCleanup.policyState').reject(new Error('Host unavailable'))
  renderPane()
  await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
  expect(control().getAttribute('aria-disabled')).toBe('true')
  announce()
  await waitFor(() => expect(control().getAttribute('aria-disabled')).toBe('false'))
})

it("keeps a refreshed answer when the first read of the host's rules fails late", async () => {
  const first = hold('settings.get')
  renderPane()
  await waitFor(() => expect(calls('settings.get')).toBe(1))
  announce()
  await waitFor(() => expect(calls('settings.get')).toBe(2))
  await act(async () => first.reject(new Error('timed out')))
  await waitFor(() => expect(control().getAttribute('aria-disabled')).toBe('false'))
  expect(screen.queryByText(/Couldn't load this host's cleanup rules/)).toBeNull()
})

it('keeps a saved rule when a refresh begun before the save answers after it', async () => {
  hostRules = { ...hostRules, merged: { enabled: true } }
  renderPane()
  await waitFor(() => expect(control().getAttribute('aria-disabled')).toBe('false'))
  expect(control().getAttribute('aria-checked')).toBe('true')
  const refresh = hold('workspaceCleanup.policyState')
  announce()
  await waitFor(() => expect(calls('workspaceCleanup.policyState')).toBe(2))
  const before = structuredClone(hostRules)

  // Turning a rule off only keeps more, so it saves without a preview.
  fireEvent.click(control())
  await waitFor(() => expect(calls('settings.update')).toBe(1))
  await waitFor(() => expect(control().getAttribute('aria-checked')).toBe('false'))
  await act(async () => refresh.resolve(policyRead(before)))
  expect(control().getAttribute('aria-checked')).toBe('false')
})
