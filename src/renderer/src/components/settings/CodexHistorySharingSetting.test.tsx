// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { CodexHistorySharingSetting } from './CodexHistorySharingSetting'

const rpc = vi.hoisted(() => ({ call: vi.fn() }))

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: rpc.call }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string, values?: Record<string, string | number>) =>
    Object.entries(values ?? {}).reduce(
      (text, [key, value]) => text.replaceAll(`{{${key}}}`, String(value)),
      fallback
    )
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ runtimeEnvironments: [{ id: 'env-1', name: 'build-box' }] })
}))

afterEach(() => {
  cleanup()
  rpc.call.mockReset()
})

const local = { target: { kind: 'local' as const }, available: true }
const remote = { target: { kind: 'environment' as const, environmentId: 'env-1' }, available: true }

function renderSetting(
  hostScope: typeof local | typeof remote,
  overrides: Partial<GlobalSettings> = {},
  updateSettings = vi.fn()
) {
  render(
    <CodexHistorySharingSetting
      settings={{ ...getDefaultSettings('/home/me'), ...overrides }}
      updateSettings={updateSettings}
      hostScope={hostScope}
    />
  )
  return { updateSettings, toggle: screen.getByRole('switch') }
}

it('turns sharing off on this computer, on by default', () => {
  const { updateSettings, toggle } = renderSetting(local)
  expect(toggle.getAttribute('aria-checked')).toBe('true')

  fireEvent.click(toggle)

  expect(updateSettings).toHaveBeenCalledWith({ codexShareHistoryAcrossAccounts: false })
  expect(rpc.call).not.toHaveBeenCalled()
})

it("reads and writes a remote host's own setting", async () => {
  rpc.call.mockImplementation(async (_target, method: string) =>
    method === 'settings.get'
      ? { settings: { codexShareHistoryAcrossAccounts: false } }
      : { settings: { codexShareHistoryAcrossAccounts: true } }
  )
  const { updateSettings, toggle } = renderSetting(remote)
  await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'))
  expect(toggle.hasAttribute('disabled')).toBe(false)

  fireEvent.click(toggle)

  await waitFor(() =>
    expect(rpc.call).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'settings.update',
      { codexShareHistoryAcrossAccounts: true },
      { timeoutMs: 15_000 }
    )
  )
  await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'))
  expect(updateSettings).not.toHaveBeenCalled()
})

it('never sends the setting to an older host that would reject it', async () => {
  rpc.call.mockResolvedValue({ settings: { agentStatusHooksEnabled: true } })
  const { toggle } = renderSetting(remote)

  await waitFor(() =>
    expect(screen.getByText('Update Orca on build-box to change this setting there.')).toBeTruthy()
  )
  expect(toggle.hasAttribute('disabled')).toBe(true)
  fireEvent.click(toggle)
  expect(rpc.call).toHaveBeenCalledTimes(1)
})
