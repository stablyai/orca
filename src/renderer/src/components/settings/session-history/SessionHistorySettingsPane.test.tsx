// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { getDefaultSettings } from '../../../../../shared/constants'
import { unavailableSessionSearchStatus } from '../../../../../shared/ai-vault/search/ai-vault-search-client'
import type { AiVaultSearchStatus } from '../../../../../shared/ai-vault/search/ai-vault-search-types'
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
    showAiVaultSearch: vi.fn(),
    markFeatureTipsSeen: vi.fn()
  }
})
vi.mock('../runtime-environments/catalog/use-runtime-environment-catalog', () => ({
  useRuntimeEnvironmentCatalog: () => ({
    environments: mocks.environments,
    isLoading: false,
    detailsByEnvironmentId: mocks.details,
    setDetailsByEnvironmentId: vi.fn(),
    mountedRef: { current: true },
    loadEnvironments: vi.fn()
  })
}))
vi.mock('@/store/index', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      openSettingsPage: vi.fn(),
      openSettingsTarget: vi.fn(),
      closeSettingsPage: mocks.closeSettingsPage,
      showAiVaultSearch: mocks.showAiVaultSearch,
      markFeatureTipsSeen: mocks.markFeatureTipsSeen
    })
}))
vi.mock('@/lib/web-client-location', () => ({ isWebClientLocation: () => mocks.web }))
vi.mock('@/hooks/use-window-stream-visibility', () => ({
  useWindowStreamVisible: () => mocks.visible
}))
vi.mock('@/i18n/i18n', () => ({
  getIntlLocale: () => 'en',
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
  messagesIndexed: 3_400,
  lastSweepCompletedAt: 1
}

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
