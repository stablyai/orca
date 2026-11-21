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

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 10, 14, 12))
  hostRules = getDefaultWorkspaceCleanupRules()
  useAppStore.setState({ settings: getDefaultSettings('/synthetic'), settingsSearchQuery: '' })
  rpc.mockReset().mockImplementation(async (_target, method: string, params) => {
    switch (method) {
      case 'settings.get':
        return { settings: { workspaceCleanupPolicy: structuredClone(hostRules) } }
      case 'workspaceCleanup.policyState':
        return {
          protocol: 3,
          expiresAt: Date.UTC(2026, 10, 14, 12, 1),
          state: { repoId: null, rules: structuredClone(hostRules), projects: [] }
        }
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

it("shows another client's change to the host's rules and toggles from it", async () => {
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
  const control = (): HTMLElement =>
    screen.getByRole('switch', { name: 'Delete merged workspaces' })
  await waitFor(() => expect(control().getAttribute('aria-disabled')).toBe('false'))
  expect(control().getAttribute('aria-checked')).toBe('false')

  // Another client turns the rule on; the host announces it on its event stream.
  hostRules = { ...hostRules, merged: { enabled: true } }
  act(() => notifyHostSettingsChanged('another-host', ['workspaceCleanupPolicy']))
  act(() => notifyHostSettingsChanged(ENVIRONMENT, ['prAutoRefresh']))
  expect(control().getAttribute('aria-checked')).toBe('false')
  act(() => notifyHostSettingsChanged(ENVIRONMENT, ['workspaceCleanupPolicy']))
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
