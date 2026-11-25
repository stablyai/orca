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
// Only the two orderings of a refresh against a save are pinned here: an old read must not roll back
// a just-saved rule, and a genuinely later read must replace the save's readback.
const announce = (): void =>
  act(() => notifyHostSettingsChanged(ENVIRONMENT, ['workspaceCleanupPolicy']))

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

it("shows another client's change read after a save settles, even if it was announced during the save", async () => {
  hostRules = { ...hostRules, merged: { enabled: true } }
  renderPane()
  await waitFor(() => expect(control().getAttribute('aria-disabled')).toBe('false'))
  const update = hold('settings.update')
  // Turning a rule off only keeps more, so it saves without a preview.
  fireEvent.click(control())
  await waitFor(() => expect(calls('settings.update')).toBe(1))
  const readback = hold('workspaceCleanup.policyState')
  // Another client changes the host while the save is in flight; the refresh queues behind the save.
  announce()
  const saved = { ...hostRules, merged: { enabled: false } }
  await act(async () => update.resolve({ settings: { workspaceCleanupPolicy: saved } }))
  await waitFor(() => expect(calls('workspaceCleanup.policyState')).toBe(3))
  hostRules = { ...saved, merged: { enabled: true } }
  await act(async () => readback.resolve(policyRead(saved)))
  await waitFor(() => expect(calls('workspaceCleanup.policyState')).toBe(4))
  await waitFor(() => expect(control().getAttribute('aria-checked')).toBe('true'))
})
