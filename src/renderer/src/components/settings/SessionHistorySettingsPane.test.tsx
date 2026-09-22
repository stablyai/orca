// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { getDefaultSettings } from '../../../../shared/constants'
import { unavailableSessionSearchStatus } from '../../../../shared/ai-vault-search-client'
import type { AiVaultSearchStatus } from '../../../../shared/ai-vault-search-types'
import { ConfirmationDialogContext } from '@/components/confirmation-dialog-context'
import { SessionHistorySettingsPane } from './SessionHistorySettingsPane'

const mocks = vi.hoisted(() => {
  const environments: { id: string; name: string }[] = []
  const statusByHost: Record<string, unknown> = {}
  const details: Record<string, unknown> = {}
  return {
    web: false,
    visible: true,
    status: vi.fn(),
    statusByHost,
    clear: vi.fn(),
    setEnabled: vi.fn(),
    environments,
    details,
    closeSettingsPage: vi.fn(),
    showAiVaultSearch: vi.fn()
  }
})
vi.mock('./use-runtime-environment-catalog', () => ({
  useRuntimeEnvironmentCatalog: () => ({
    environments: mocks.environments,
    isLoading: false,
    detailsByEnvironmentId: mocks.details,
    setDetailsByEnvironmentId: vi.fn(),
    mountedRef: { current: true },
    loadEnvironments: vi.fn()
  })
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      openSettingsPage: vi.fn(),
      openSettingsTarget: vi.fn(),
      closeSettingsPage: mocks.closeSettingsPage,
      showAiVaultSearch: mocks.showAiVaultSearch
    })
}))
vi.mock('@/lib/web-client-location', () => ({ isWebClientLocation: () => mocks.web }))
vi.mock('@/hooks/use-window-stream-visibility', () => ({
  useWindowStreamVisible: () => mocks.visible
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, args?: Record<string, unknown>) =>
    fallback.replace(/{{(\w+)}}/g, (_, key: string) => String(args?.[key]))
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))

function pane(
  enabled = false,
  confirm = vi.fn().mockResolvedValue(true),
  save = vi.fn().mockResolvedValue(undefined),
  historyDays: number | null = null
) {
  return render(
    <ConfirmationDialogContext.Provider value={confirm}>
      <SessionHistorySettingsPane
        settings={{
          ...getDefaultSettings('/synthetic'),
          aiVaultSearch: { enabled, historyDays }
        }}
        updateSettings={save}
      />
    </ConfirmationDialogContext.Provider>
  )
}
const CONNECTED_DETAILS = {
  status: 'ready',
  runtimeStatus: {
    runtimeId: 'runtime-1',
    rendererGraphEpoch: 1,
    graphStatus: 'ready',
    authoritativeWindowId: 1,
    liveTabCount: 1,
    liveLeafCount: 1,
    appVersion: '1.4.202'
  },
  remoteControl: null,
  compatibility: { kind: 'ok', clientProtocolVersion: 1, serverProtocolVersion: 1 },
  error: null
}
const OFFLINE_DETAILS = {
  status: 'error',
  runtimeStatus: null,
  remoteControl: null,
  compatibility: null,
  error: 'unreachable'
}
/** Answers status per host so one pane can hold servers in different states. */
function statusByHost(): void {
  mocks.status.mockImplementation(async (hostId: string) => {
    const answer = mocks.statusByHost[hostId]
    if (answer === undefined) {
      return unavailableSessionSearchStatus()
    }
    if (answer === 'too-old') {
      throw new Error("Error invoking remote method 'x': Error: host-too-old")
    }
    return answer
  })
}
const enableAllButton = () => screen.queryByRole('button', { name: 'Enable on all computers' })
async function openAdvanced(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Advanced/ }))
  })
}
const current: AiVaultSearchStatus = {
  ...unavailableSessionSearchStatus(),
  enabled: true,
  phase: 'current',
  filesIndexed: 12,
  messagesIndexed: 3_400,
  lastSweepCompletedAt: 1
}
const off: AiVaultSearchStatus = unavailableSessionSearchStatus()
beforeEach(() => {
  vi.useFakeTimers()
  mocks.web = false
  mocks.visible = true
  mocks.environments = []
  mocks.details = {}
  mocks.statusByHost = {}
  mocks.closeSettingsPage.mockReset()
  mocks.showAiVaultSearch.mockReset()
  mocks.status.mockReset().mockResolvedValue(current)
  mocks.clear.mockReset().mockResolvedValue(undefined)
  mocks.setEnabled.mockReset().mockResolvedValue(current)
  vi.mocked(toast.success).mockClear()
  vi.stubGlobal('api', undefined)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      aiVault: {
        searchStatus: mocks.status,
        clearSearchIndex: mocks.clear,
        setSearchEnabled: mocks.setEnabled
      }
    }
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('turns search on from the switch alone, touching no transcript while it is off', async () => {
  const save = vi.fn().mockResolvedValue(undefined)
  const confirm = vi.fn().mockResolvedValue(true)
  pane(false, confirm, save)
  expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
  expect(screen.getByText(/Nothing leaves that computer/)).toBeInTheDocument()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000)
  })
  expect(mocks.status).not.toHaveBeenCalled()
  await act(async () => {
    fireEvent.click(screen.getByRole('switch'))
  })
  expect(confirm).not.toHaveBeenCalled()
  expect(save).toHaveBeenCalledWith({ aiVaultSearch: { enabled: true, historyDays: null } })
})

it('sends the user to the sidebar panel with one click', async () => {
  pane(true)
  await act(async () => {})
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
  })
  expect(mocks.showAiVaultSearch).toHaveBeenCalledOnce()
  expect(mocks.closeSettingsPage).toHaveBeenCalledOnce()
})

it('turns search off from the switch alone', async () => {
  const confirm = vi.fn().mockResolvedValue(true)
  const save = vi.fn().mockResolvedValue(undefined)
  pane(true, confirm, save)
  await act(async () => {
    fireEvent.click(screen.getByRole('switch'))
  })
  expect(confirm).not.toHaveBeenCalled()
  expect(save).toHaveBeenCalledWith({ aiVaultSearch: { enabled: false, historyDays: null } })
})

it('keeps the stored retention window without offering a control for it', async () => {
  const save = vi.fn().mockResolvedValue(undefined)
  pane(false, undefined, save, 30)
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  expect(screen.queryByText(/Searchable history/)).not.toBeInTheDocument()
  await act(async () => {
    fireEvent.click(screen.getByRole('switch'))
  })
  expect(save).toHaveBeenCalledWith({ aiVaultSearch: { enabled: true, historyDays: 30 } })
})

it('shows failed saves inline and unlocks controls', async () => {
  pane(false, undefined, vi.fn().mockRejectedValue(new Error('write failed')))
  await act(async () => {
    fireEvent.click(screen.getByRole('switch'))
  })
  expect(screen.getByRole('alert')).toHaveTextContent('Could not save')
  expect(screen.getByRole('switch')).toBeEnabled()
})

it('hides the delete control behind Advanced', async () => {
  pane(false)
  expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument()
  await openAdvanced()
  expect(screen.getByRole('button', { name: 'Clear' })).toBeInTheDocument()
  expect(screen.getByText(/Removes the searchable copy/)).toBeInTheDocument()
})

it('deletes only after confirmation, supports deleting while disabled, and reports failures', async () => {
  const confirm = vi.fn().mockResolvedValue(false)
  pane(false, confirm)
  await openAdvanced()
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
  })
  expect(mocks.clear).not.toHaveBeenCalled()
  expect(confirm).toHaveBeenCalledWith(
    expect.objectContaining({
      title: 'Clear search data on this computer?',
      description: expect.stringContaining('Removes the searchable copy'),
      confirmLabel: 'Clear'
    })
  )
  confirm.mockResolvedValue(true)
  mocks.clear.mockRejectedValue(new Error('service unavailable'))
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
  })
  expect(mocks.clear).toHaveBeenCalledOnce()
  expect(screen.getByRole('alert')).toHaveTextContent('Could not clear')
})

it('turns search off before deleting so the host does not rebuild the index', async () => {
  const order: string[] = []
  const save = vi.fn().mockImplementation(async () => {
    order.push('save')
  })
  mocks.clear.mockImplementation(async () => {
    order.push('clear')
  })
  pane(true, vi.fn().mockResolvedValue(true), save)
  await openAdvanced()
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
  })
  expect(save).toHaveBeenCalledWith({ aiVaultSearch: { enabled: false, historyDays: null } })
  expect(order).toEqual(['save', 'clear'])
  expect(screen.getAllByText(/Turns off search and removes/).length).toBeGreaterThan(0)
  expect(toast.success).toHaveBeenCalledWith('Search turned off and search data cleared.')
})

it('deletes without a settings write when search is already off', async () => {
  const save = vi.fn().mockResolvedValue(undefined)
  pane(false, vi.fn().mockResolvedValue(true), save)
  await openAdvanced()
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
  })
  expect(save).not.toHaveBeenCalled()
  expect(mocks.clear).toHaveBeenCalledOnce()
  expect(toast.success).toHaveBeenCalledWith('Search data cleared.')
})

it('keeps the index when turning search off fails', async () => {
  const save = vi.fn().mockRejectedValue(new Error('write failed'))
  pane(true, vi.fn().mockResolvedValue(true), save)
  await openAdvanced()
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
  })
  expect(mocks.clear).not.toHaveBeenCalled()
  expect(screen.getByRole('alert')).toHaveTextContent('Could not save')
  expect(screen.getByRole('button', { name: 'Clear' })).toBeEnabled()
})

it('does not execute a confirmation after navigating away', async () => {
  let accept: (value: boolean) => void = () => undefined
  const confirmation = new Promise<boolean>((resolve) => {
    accept = resolve
  })
  const view = pane(false, vi.fn().mockReturnValue(confirmation))
  await openAdvanced()
  fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
  view.unmount()
  await act(async () => {
    accept(true)
  })
  expect(mocks.clear).not.toHaveBeenCalled()
})

it('leaves paired-client controls unsupported without local calls', async () => {
  mocks.web = true
  pane(true)
  expect(screen.getByRole('switch')).toBeDisabled()
  await openAdvanced()
  expect(screen.getByRole('button', { name: 'Clear' })).toBeDisabled()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000)
  })
  expect(mocks.status).not.toHaveBeenCalled()
})

it('keeps the last index status visible while a save is in flight', async () => {
  let finishSave: () => void = () => undefined
  const save = vi.fn().mockReturnValue(
    new Promise<void>((resolve) => {
      finishSave = resolve
    })
  )
  pane(true, vi.fn().mockResolvedValue(true), save)
  await act(async () => {})
  expect(screen.getByRole('status')).toHaveTextContent('12 sessions · 3.4K messages searchable')
  await act(async () => {
    fireEvent.click(screen.getByRole('switch'))
  })
  expect(screen.getByRole('status')).toHaveTextContent('12 sessions · 3.4K messages searchable')
  await act(async () => {
    finishSave()
  })
})

it('lists one row per paired Orca server under this computer, and says where SSH stands', async () => {
  mocks.environments = [
    { id: 'env-1', name: 'build-box' },
    { id: 'env-2', name: 'office-mini' }
  ]
  pane(true)
  await act(async () => {})
  const switches = screen.getAllByRole('switch')
  expect(switches).toHaveLength(3)
  expect(screen.getByRole('switch', { name: 'Search sessions on build-box' })).toBeInTheDocument()
  expect(screen.getByRole('switch', { name: 'Search sessions on office-mini' })).toBeInTheDocument()
  expect(mocks.status).toHaveBeenCalledWith('local')
  expect(screen.getByText('This computer')).toBeInTheDocument()
  expect(screen.getByText('Orca remote servers')).toBeInTheDocument()
})

it('offers only this computer to a paired client, with no server rows', async () => {
  mocks.web = true
  mocks.environments = [{ id: 'env-1', name: 'build-box' }]
  pane(true)
  await act(async () => {})
  expect(screen.getAllByRole('switch')).toHaveLength(1)
  expect(screen.getByRole('switch')).toBeDisabled()
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  expect(enableAllButton()).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Open' })).not.toBeInTheDocument()
  expect(mocks.status).not.toHaveBeenCalled()
})

/** Local on, one server on, one off, one offline, one too old. */
function mixedFleet(): void {
  mocks.environments = [
    { id: 'on', name: 'build-01' },
    { id: 'off', name: 'gpu-a' },
    { id: 'gone', name: 'linux 1' },
    { id: 'old', name: 'm4 air' }
  ]
  mocks.details = {
    on: CONNECTED_DETAILS,
    off: CONNECTED_DETAILS,
    gone: OFFLINE_DETAILS,
    old: CONNECTED_DETAILS
  }
  mocks.statusByHost = {
    local: current,
    'runtime:on': current,
    'runtime:off': off,
    'runtime:old': 'too-old'
  }
  statusByHost()
}

it('leaves a lone computer to its own switch, with no roll-up above it', async () => {
  pane(true)
  await act(async () => {})
  expect(screen.getAllByRole('switch')).toHaveLength(1)
  expect(enableAllButton()).not.toBeInTheDocument()
  expect(screen.queryByText('This computer')).not.toBeInTheDocument()
  expect(screen.queryByText('Orca remote servers')).not.toBeInTheDocument()
})

it('offers the button only while a paired server is reachable and off', async () => {
  mixedFleet()
  pane(true)
  await act(async () => {})
  expect(enableAllButton()).toBeInTheDocument()

  // gpu-a was the only eligible one; with it on, the offline and too-old rows leave nothing to do.
  mocks.statusByHost = { ...mocks.statusByHost, 'runtime:off': current }
  statusByHost()
  cleanup()
  pane(true)
  await act(async () => {})
  expect(enableAllButton()).not.toBeInTheDocument()
})

it('does not offer the button for a server whose state is still unknown', async () => {
  mocks.environments = [{ id: 'a', name: 'gpu-a' }]
  mocks.details = {}
  mocks.statusByHost = { local: current }
  statusByHost()
  pane(true)
  await act(async () => {})
  expect(enableAllButton()).not.toBeInTheDocument()
})

it('enables every reachable server and skips the ones it cannot', async () => {
  mixedFleet()
  const confirm = vi.fn().mockResolvedValue(true)
  pane(true, confirm)
  await act(async () => {})
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Enable on all computers' }))
  })
  expect(confirm).not.toHaveBeenCalled()
  // linux 1 is offline and m4 air is too old, so neither is asked; build-01 is already on.
  expect(mocks.setEnabled.mock.calls.map((call) => call[0])).toEqual(['runtime:off'])
})

it('enables this computer as part of enabling them all', async () => {
  mocks.environments = [{ id: 'off', name: 'gpu-a' }]
  mocks.details = { off: CONNECTED_DETAILS }
  mocks.statusByHost = { local: off, 'runtime:off': off }
  statusByHost()
  const save = vi.fn().mockResolvedValue(undefined)
  pane(false, undefined, save)
  await act(async () => {})
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Enable on all computers' }))
  })
  expect(save).toHaveBeenCalledWith({ aiVaultSearch: { enabled: true, historyDays: null } })
  expect(mocks.setEnabled).toHaveBeenCalledWith('runtime:off', true)
})

it('keeps going after a host refuses, and names the one that did', async () => {
  mocks.environments = [
    { id: 'a', name: 'gpu-a' },
    { id: 'b', name: 'gpu-b' }
  ]
  mocks.details = { a: CONNECTED_DETAILS, b: CONNECTED_DETAILS }
  mocks.statusByHost = { local: current, 'runtime:a': off, 'runtime:b': off }
  statusByHost()
  mocks.setEnabled.mockRejectedValueOnce(new Error('relay down')).mockResolvedValue(current)
  pane(true)
  await act(async () => {})
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Enable on all computers' }))
  })
  expect(mocks.setEnabled.mock.calls.map((call) => call[0])).toEqual(['runtime:a', 'runtime:b'])
  expect(screen.getByRole('alert')).toHaveTextContent('Could not change session search on gpu-a')
})

it('remembers nothing after a server is turned back off by hand', async () => {
  mocks.environments = [{ id: 'a', name: 'gpu-a' }]
  mocks.details = { a: CONNECTED_DETAILS }
  mocks.statusByHost = { local: current, 'runtime:a': current }
  statusByHost()
  const save = vi.fn().mockResolvedValue(undefined)
  pane(true, undefined, save)
  await act(async () => {})
  expect(enableAllButton()).not.toBeInTheDocument()
  mocks.setEnabled.mockResolvedValue(off)
  await act(async () => {
    fireEvent.click(screen.getByRole('switch', { name: 'Search sessions on gpu-a' }))
  })
  // The row went off, so the offer comes straight back; no preference was written either way.
  expect(enableAllButton()).toBeInTheDocument()
  expect(save).not.toHaveBeenCalled()
})

it('folds the list past six computers and orders it by what the user can act on', async () => {
  mocks.environments = [
    { id: 'gone', name: 'zz-offline' },
    { id: 'old', name: 'aa-old' },
    { id: 'off1', name: 'bb-off' },
    { id: 'off2', name: 'aa-off' },
    { id: 'on1', name: 'zz-on' },
    { id: 'on2', name: 'aa-on' }
  ]
  mocks.details = {
    gone: OFFLINE_DETAILS,
    old: CONNECTED_DETAILS,
    off1: CONNECTED_DETAILS,
    off2: CONNECTED_DETAILS,
    on1: CONNECTED_DETAILS,
    on2: CONNECTED_DETAILS
  }
  mocks.statusByHost = {
    local: current,
    'runtime:old': 'too-old',
    'runtime:off1': off,
    'runtime:off2': off,
    'runtime:on1': current,
    'runtime:on2': current
  }
  statusByHost()
  pane(true)
  await act(async () => {})
  // The local row's label is the host's own name, which differs per platform; the servers are the order under test.
  const serverNames = (): string[] =>
    screen
      .getAllByRole('switch')
      .map((element) => element.getAttribute('aria-label') ?? '')
      .filter((label) => label.startsWith('Search sessions on '))
      .map((label) => label.replace('Search sessions on ', ''))
      .slice(1)
  expect(serverNames()).toEqual(['aa-on', 'zz-on', 'aa-off', 'bb-off', 'aa-old'])
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Show 1 more' }))
  })
  expect(serverNames()).toEqual(['aa-on', 'zz-on', 'aa-off', 'bb-off', 'aa-old', 'zz-offline'])
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Show fewer' }))
  })
  expect(screen.getByRole('button', { name: 'Show 1 more' })).toBeInTheDocument()
})
