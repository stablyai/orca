// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { useState } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { ExecutionHostScope } from '../../../../shared/execution-host'
import { createRuntimeStatusHydration } from '@/store/slices/runtime-status-hydration'
import {
  buildAiVaultHostScopeOptions,
  buildRuntimeAiVaultHostScopeOptions
} from './ai-vault-host-scope'
import { VaultHostScopeMenu } from './AiVaultPanelControls'

const actions = vi.hoisted(() => ({ refreshRuntimeEnvironmentCatalog: vi.fn() }))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof actions) => unknown) => selector(actions)
}))
vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string, args?: Record<string, unknown>) =>
    fallback.replace(/{{(\w+)}}/g, (_, key: string) => String(args?.[key]))
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it('refreshes CLI-paired servers inside an open menu without changing the selected host', async () => {
  const user = userEvent.setup()
  const server: PublicKnownRuntimeEnvironment = {
    id: 'travel-server',
    name: 'Travel Server',
    createdAt: Date.parse('2026-10-04T09:00:00Z'),
    updatedAt: Date.parse('2026-10-04T09:00:00Z'),
    runtimeId: null,
    lastUsedAt: null,
    endpoints: [
      { id: 'websocket', kind: 'websocket', endpoint: 'ws://localhost:6768', label: 'WebSocket' }
    ],
    preferredEndpointId: 'websocket'
  }
  let diskRows: PublicKnownRuntimeEnvironment[] = []
  const list = vi.fn(async () => diskRows)
  const onScopeChange = vi.fn()
  let current: readonly PublicKnownRuntimeEnvironment[] = []
  let publishUi: (rows: readonly PublicKnownRuntimeEnvironment[]) => void = () => {}
  actions.refreshRuntimeEnvironmentCatalog.mockImplementation(
    createRuntimeStatusHydration({
      listEnvironments: list,
      getCurrentEnvironments: () => current,
      publishEnvironments: (rows) => {
        current = rows
        publishUi(rows)
      },
      markCatalogSettled: vi.fn()
    })
  )
  function HistoryHostPicker() {
    const [environments, setEnvironments] = useState<readonly PublicKnownRuntimeEnvironment[]>([])
    const [scope, setScope] = useState<ExecutionHostScope>('ssh:dev-box')
    publishUi = setEnvironments
    return (
      <VaultHostScopeMenu
        executionHostScope={scope}
        hostOptions={buildAiVaultHostScopeOptions({
          activeExecutionHostScope: 'ssh:dev-box',
          runtimeHostOptions: buildRuntimeAiVaultHostScopeOptions(environments)
        })}
        onExecutionHostScopeChange={(value) => {
          onScopeChange(value)
          setScope(value)
        }}
      />
    )
  }
  render(<HistoryHostPicker />)
  // The CLI saves the pairing after the panel has already mounted.
  diskRows = [server]
  await user.click(screen.getByRole('button', { name: /Session History host/ }))
  const option = await screen.findByRole('menuitemradio', { name: 'Travel Server' })
  expect(list).toHaveBeenCalledOnce()
  expect(onScopeChange).not.toHaveBeenCalled()
  expect(screen.getByRole('menuitemradio', { name: 'dev-box' })).toHaveAttribute(
    'aria-checked',
    'true'
  )
  await user.click(option)
  expect(onScopeChange).toHaveBeenCalledExactlyOnceWith('runtime:travel-server')
  await waitFor(() => expect(screen.getByRole('button', { name: /Travel Server/ })).toBeVisible())
})
