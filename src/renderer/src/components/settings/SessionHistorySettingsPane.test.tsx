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
  return {
    web: false,
    visible: true,
    status: vi.fn(),
    clear: vi.fn(),
    setEnabled: vi.fn(),
    environments
  }
})
vi.mock('./use-runtime-environment-catalog', () => ({
  useRuntimeEnvironmentCatalog: () => ({
    environments: mocks.environments,
    isLoading: false,
    detailsByEnvironmentId: {},
    setDetailsByEnvironmentId: vi.fn(),
    mountedRef: { current: true },
    loadEnvironments: vi.fn()
  })
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ openSettingsPage: vi.fn(), openSettingsTarget: vi.fn() })
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
  lastSweepCompletedAt: 1
}
beforeEach(() => {
  vi.useFakeTimers()
  mocks.web = false
  mocks.visible = true
  mocks.environments = []
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

it('requires opt-in and saves the existing policy without touching transcripts or polling while off', async () => {
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
  expect(confirm).toHaveBeenCalledWith(
    expect.objectContaining({
      title: 'Turn on session search?',
      description: expect.stringContaining('It stays on this computer'),
      confirmLabel: 'Turn on'
    })
  )
  expect(save).toHaveBeenCalledWith({ aiVaultSearch: { enabled: true, historyDays: null } })
})

it('leaves search off when the indexing consent is declined', async () => {
  const save = vi.fn().mockResolvedValue(undefined)
  pane(false, vi.fn().mockResolvedValue(false), save)
  await act(async () => {
    fireEvent.click(screen.getByRole('switch'))
  })
  expect(save).not.toHaveBeenCalled()
  expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
})

it('turns search off without asking again', async () => {
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
  expect(screen.getByRole('status')).toHaveTextContent('Ready · 12 sessions searchable')
  await act(async () => {
    fireEvent.click(screen.getByRole('switch'))
  })
  expect(screen.getByRole('status')).toHaveTextContent('Ready · 12 sessions searchable')
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
  expect(
    screen.getByText('Search from the Agent Session History panel in the sidebar.')
  ).toBeInTheDocument()
})

it('offers only this computer to a paired client, with no server rows', async () => {
  mocks.web = true
  mocks.environments = [{ id: 'env-1', name: 'build-box' }]
  pane(true)
  await act(async () => {})
  expect(screen.getAllByRole('switch')).toHaveLength(1)
  expect(screen.getByRole('switch')).toBeDisabled()
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  expect(mocks.status).not.toHaveBeenCalled()
})
