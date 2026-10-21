// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { unavailableSessionSearchStatus } from '../../../../shared/ai-vault-search-client'
import type { AiVaultSearchStatus } from '../../../../shared/ai-vault-search-types'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import { ConfirmationDialogContext } from '@/components/confirmation-dialog-context'
import { SessionHistoryComputerRow } from './SessionHistoryComputerRow'
import { SessionHistoryServerRow } from './SessionHistoryServerRow'
import type { RuntimeHostDetails } from './runtime-environment-host-details'
import type { SessionSearchComputerState } from './session-search-computer-rollup'

const mocks = vi.hoisted(() => ({
  visible: true,
  status: vi.fn(),
  setEnabled: vi.fn(),
  openSettingsPage: vi.fn(),
  openSettingsTarget: vi.fn()
}))
vi.mock('@/hooks/use-window-stream-visibility', () => ({
  useWindowStreamVisible: () => mocks.visible
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, args?: Record<string, unknown>) =>
    fallback.replace(/{{(\w+)}}/g, (_, key: string) => String(args?.[key]))
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      openSettingsPage: mocks.openSettingsPage,
      openSettingsTarget: mocks.openSettingsTarget
    })
}))

const runningIndex: AiVaultSearchStatus = {
  ...unavailableSessionSearchStatus(),
  enabled: true,
  phase: 'current',
  filesIndexed: 4_880,
  messagesIndexed: 1_400_000,
  lastSweepCompletedAt: 1
}
const environment: PublicKnownRuntimeEnvironment = {
  id: 'env-1',
  name: 'build-box',
  createdAt: 0,
  updatedAt: 0,
  lastUsedAt: null,
  runtimeId: null,
  endpoints: [{ id: 'e1', kind: 'websocket', label: 'lan', endpoint: 'wss://build-box' }],
  preferredEndpointId: 'e1'
}
function connectedDetails(appVersion = '1.4.202'): RuntimeHostDetails {
  const runtimeStatus: RuntimeStatus = {
    runtimeId: 'runtime-1',
    rendererGraphEpoch: 1,
    graphStatus: 'ready',
    authoritativeWindowId: 1,
    liveTabCount: 1,
    liveLeafCount: 1,
    appVersion
  }
  return {
    status: 'ready',
    runtimeStatus,
    remoteControl: null,
    compatibility: { kind: 'ok', clientProtocolVersion: 1, serverProtocolVersion: 1 },
    error: null
  }
}
function serverRow(
  details: RuntimeHostDetails | undefined,
  confirm = vi.fn().mockResolvedValue(true),
  onError = vi.fn(),
  onStateChange?: (environmentId: string, state: SessionSearchComputerState) => void
) {
  return render(
    <ConfirmationDialogContext.Provider value={confirm}>
      <SessionHistoryServerRow
        environment={environment}
        details={details}
        onError={onError}
        {...(onStateChange ? { onStateChange } : {})}
      />
    </ConfirmationDialogContext.Provider>
  )
}
const serverSwitch = (): HTMLElement =>
  screen.getByRole('switch', { name: 'Search sessions on build-box' })

beforeEach(() => {
  vi.useFakeTimers()
  mocks.visible = true
  mocks.status.mockReset().mockResolvedValue(runningIndex)
  mocks.setEnabled.mockReset().mockResolvedValue(runningIndex)
  mocks.openSettingsPage.mockReset()
  mocks.openSettingsTarget.mockReset()
  vi.stubGlobal('api', undefined)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { aiVault: { searchStatus: mocks.status, setSearchEnabled: mocks.setEnabled } }
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('renders a computer as icon, name, version, one status line and a switch', () => {
  render(
    <SessionHistoryComputerRow
      kind="server"
      name="build-box"
      version="1.4.202"
      status="12 sessions · 1.4K messages searchable"
      details={['2 sessions could not be read and will be retried.']}
      checked
      onToggle={vi.fn()}
    />
  )
  expect(screen.getByText('build-box')).toBeInTheDocument()
  expect(screen.getByText('Orca v1.4.202')).toBeInTheDocument()
  expect(screen.getByRole('status')).toHaveTextContent('12 sessions · 1.4K messages searchable')
  expect(screen.getByText('2 sessions could not be read and will be retried.')).toBeInTheDocument()
  expect(serverSwitch()).toHaveAttribute('aria-checked', 'true')
})

it('omits the status line when this client cannot read the host index', () => {
  render(
    <SessionHistoryComputerRow kind="local" name="Local Mac" checked={false} onToggle={vi.fn()} />
  )
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
})

it('reports a reachable server by its live index status and version', async () => {
  serverRow(connectedDetails())
  await act(async () => {})
  expect(mocks.status).toHaveBeenCalledWith('runtime:env-1')
  expect(screen.getByRole('status')).toHaveTextContent('4,880 sessions · 1.4M messages searchable')
  expect(screen.getByText('Orca v1.4.202')).toBeInTheDocument()
  expect(serverSwitch()).toHaveAttribute('aria-checked', 'true')
})

it('leaves a reachable server with search off to its switch, with no status sentence', async () => {
  mocks.status.mockResolvedValue(unavailableSessionSearchStatus())
  serverRow(connectedDetails())
  await act(async () => {})
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  expect(serverSwitch()).toHaveAttribute('aria-checked', 'false')
})

it('publishes each server state the pane counts and orders by', async () => {
  const onStateChange = vi.fn()
  mocks.status.mockResolvedValue(unavailableSessionSearchStatus())
  serverRow(connectedDetails(), undefined, undefined, onStateChange)
  await act(async () => {})
  expect(onStateChange).toHaveBeenLastCalledWith('env-1', 'off')
  mocks.status.mockResolvedValue(runningIndex)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000)
  })
  expect(onStateChange).toHaveBeenLastCalledWith('env-1', 'on')
})

it('publishes offline and needs-update states without claiming either too early', async () => {
  const onStateChange = vi.fn()
  const { unmount } = serverRow(undefined, undefined, undefined, onStateChange)
  await act(async () => {})
  expect(onStateChange).toHaveBeenLastCalledWith('env-1', 'checking')
  unmount()
  serverRow(
    {
      status: 'error',
      runtimeStatus: null,
      remoteControl: null,
      compatibility: null,
      error: 'unreachable'
    },
    undefined,
    undefined,
    onStateChange
  )
  await act(async () => {})
  expect(onStateChange).toHaveBeenLastCalledWith('env-1', 'offline')

  cleanup()
  mocks.status.mockRejectedValue(new Error("Error invoking remote method 'x': Error: host-too-old"))
  serverRow(connectedDetails('1.4.190'), undefined, undefined, onStateChange)
  await act(async () => {})
  expect(onStateChange).toHaveBeenLastCalledWith('env-1', 'needs-update')
})

it('keeps an offline server dimmed, disabled and honest about its index', async () => {
  serverRow({
    status: 'error',
    runtimeStatus: null,
    remoteControl: null,
    compatibility: null,
    error: 'unreachable'
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000)
  })
  expect(mocks.status).not.toHaveBeenCalled()
  expect(screen.getByRole('status')).toHaveTextContent('Offline')
  expect(serverSwitch()).toBeDisabled()
  expect(serverSwitch()).toHaveAttribute('aria-checked', 'false')
})

it('turns a server on straight from its switch, with nothing to confirm', async () => {
  const confirm = vi.fn().mockResolvedValue(true)
  mocks.status.mockResolvedValue(unavailableSessionSearchStatus())
  serverRow(connectedDetails(), confirm)
  await act(async () => {})
  await act(async () => {
    fireEvent.click(serverSwitch())
  })
  expect(confirm).not.toHaveBeenCalled()
  expect(mocks.setEnabled).toHaveBeenCalledWith('runtime:env-1', true)
  expect(screen.getByRole('status')).toHaveTextContent('4,880 sessions · 1.4M messages searchable')
})

it('turns a server off straight from its switch', async () => {
  const confirm = vi.fn().mockResolvedValue(true)
  serverRow(connectedDetails(), confirm)
  await act(async () => {})
  mocks.setEnabled.mockResolvedValue(unavailableSessionSearchStatus())
  await act(async () => {
    fireEvent.click(serverSwitch())
  })
  expect(confirm).not.toHaveBeenCalled()
  expect(mocks.setEnabled).toHaveBeenCalledWith('runtime:env-1', false)
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
})

it('turns a host-too-old rejection into the update-server state', async () => {
  mocks.status.mockResolvedValue(unavailableSessionSearchStatus())
  mocks.setEnabled.mockRejectedValue(
    new Error("Error invoking remote method 'aiVault:setSearchEnabled': Error: host-too-old")
  )
  const onError = vi.fn()
  serverRow(connectedDetails('1.4.190'), vi.fn().mockResolvedValue(true), onError)
  await act(async () => {})
  await act(async () => {
    fireEvent.click(serverSwitch())
  })
  expect(screen.getByRole('status')).toHaveTextContent('Needs a newer version of Orca.')
  expect(serverSwitch()).toBeDisabled()
  expect(onError).not.toHaveBeenCalledWith(expect.stringContaining('Could not change'))
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Update server' }))
  })
  expect(mocks.openSettingsPage).toHaveBeenCalledOnce()
  expect(mocks.openSettingsTarget).toHaveBeenCalledWith({
    pane: 'servers',
    repoId: null,
    sectionId: 'env-1'
  })
})

it('surfaces any other failure to change a server through the pane alert', async () => {
  mocks.status.mockResolvedValue(unavailableSessionSearchStatus())
  mocks.setEnabled.mockRejectedValue(new Error('relay down'))
  const onError = vi.fn()
  serverRow(connectedDetails(), vi.fn().mockResolvedValue(true), onError)
  await act(async () => {})
  await act(async () => {
    fireEvent.click(serverSwitch())
  })
  expect(onError).toHaveBeenLastCalledWith(
    'Could not change session search on build-box. Try again.'
  )
  expect(serverSwitch()).toBeEnabled()
})
