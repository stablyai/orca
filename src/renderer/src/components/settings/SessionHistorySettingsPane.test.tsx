// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { unavailableSessionSearchStatus } from '../../../../shared/ai-vault-search-client'
import type { AiVaultSearchStatus } from '../../../../shared/ai-vault-search-types'
import { ConfirmationDialogContext } from '@/components/confirmation-dialog-context'
import { SessionHistorySettingsPane } from './SessionHistorySettingsPane'

const mocks = vi.hoisted(() => ({ web: false, visible: true, status: vi.fn(), clear: vi.fn() }))
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
  mocks.status.mockReset().mockResolvedValue(current)
  mocks.clear.mockReset().mockResolvedValue(undefined)
  vi.stubGlobal('api', undefined)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { aiVault: { searchStatus: mocks.status, clearSearchIndex: mocks.clear } }
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
  expect(screen.getByText(/Content is not redacted/)).toBeInTheDocument()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000)
  })
  expect(mocks.status).not.toHaveBeenCalled()
  await act(async () => {
    fireEvent.click(screen.getByRole('switch'))
  })
  expect(confirm).toHaveBeenCalledWith(
    expect.objectContaining({
      title: 'Start indexing agent sessions?',
      description: expect.stringContaining('content is not redacted'),
      confirmLabel: 'Start indexing'
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
  expect(screen.queryByRole('button', { name: 'Delete index' })).not.toBeInTheDocument()
  await openAdvanced()
  expect(screen.getByRole('button', { name: 'Delete index' })).toBeInTheDocument()
  expect(screen.getByText(/Search stays off/)).toBeInTheDocument()
})

it('deletes only after confirmation, supports deleting while disabled, and reports failures', async () => {
  const confirm = vi.fn().mockResolvedValue(false)
  pane(false, confirm)
  await openAdvanced()
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Delete index' }))
  })
  expect(mocks.clear).not.toHaveBeenCalled()
  expect(confirm).toHaveBeenCalledWith(
    expect.objectContaining({
      title: 'Delete this computer’s search index?',
      description: expect.stringContaining('Search stays off'),
      confirmLabel: 'Delete index'
    })
  )
  confirm.mockResolvedValue(true)
  mocks.clear.mockRejectedValue(new Error('service unavailable'))
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Delete index' }))
  })
  expect(mocks.clear).toHaveBeenCalledOnce()
  expect(screen.getByRole('alert')).toHaveTextContent('Could not clear')
})

it('does not execute a confirmation after navigating away', async () => {
  let accept: (value: boolean) => void = () => undefined
  const confirmation = new Promise<boolean>((resolve) => {
    accept = resolve
  })
  const view = pane(false, vi.fn().mockReturnValue(confirmation))
  await openAdvanced()
  fireEvent.click(screen.getByRole('button', { name: 'Delete index' }))
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
  expect(screen.getByRole('button', { name: 'Delete index' })).toBeDisabled()
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
  expect(screen.getByRole('status')).toHaveTextContent('Up to date · 12 files indexed')
  await act(async () => {
    fireEvent.click(screen.getByRole('switch'))
  })
  expect(screen.getByRole('status')).toHaveTextContent('Up to date · 12 files indexed')
  await act(async () => {
    finishSave()
  })
})
