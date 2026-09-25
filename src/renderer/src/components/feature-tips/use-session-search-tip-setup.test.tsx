// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { unavailableSessionSearchStatus } from '../../../../shared/ai-vault-search-client'
import type { AiVaultSearchStatus } from '../../../../shared/ai-vault-search-types'
import {
  useSessionSearchTipSetup,
  type SessionSearchTipSetup
} from './use-session-search-tip-setup'

type Mocks = {
  settings: { aiVaultSearch: { enabled: boolean; historyDays: null } }
  status: AiVaultSearchStatus | null
  updateSettingsOrThrow: () => Promise<void>
}

const mocks = vi.hoisted((): Mocks => ({
  settings: { aiVaultSearch: { enabled: false, historyDays: null } },
  status: null,
  updateSettingsOrThrow: async () => {}
}))

vi.mock('@/store', () => {
  const state = () => ({
    settings: mocks.settings,
    showAiVaultSearch: vi.fn(),
    updateSettingsOrThrow: mocks.updateSettingsOrThrow
  })
  const useAppStore = Object.assign(
    (selector: (s: ReturnType<typeof state>) => unknown) => selector(state()),
    { getState: state }
  )
  return { useAppStore }
})

vi.mock('@/components/settings/use-session-search-status', () => ({
  useSessionSearchStatus: () => ({
    status: mocks.status,
    failed: false,
    hostTooOld: false,
    adopt: () => {}
  })
}))

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

let latest: SessionSearchTipSetup | null = null
function Probe(): null {
  latest = useSessionSearchTipSetup({ dialogOpen: true })
  return null
}

const container = document.createElement('div')
const root = createRoot(container)

afterEach(() => {
  act(() => root.render(null))
  mocks.settings = { aiVaultSearch: { enabled: false, historyDays: null } }
  mocks.status = null
})

function render(): void {
  act(() => root.render(<Probe />))
}

describe('useSessionSearchTipSetup', () => {
  it('moves from offer to indexing to ready as the first index builds', async () => {
    render()
    expect(latest?.stage).toBe('offer')

    await act(async () => {
      await latest?.enable()
    })
    mocks.settings = { aiVaultSearch: { enabled: true, historyDays: null } }
    mocks.status = { ...unavailableSessionSearchStatus(), enabled: true, phase: 'indexing' }
    render()
    expect(latest?.stage).toBe('indexing')

    mocks.status = {
      ...unavailableSessionSearchStatus(),
      enabled: true,
      phase: 'current',
      lastSweepCompletedAt: 1
    }
    render()
    expect(latest?.stage).toBe('ready')
  })

  it('returns to the offer when search is turned off in Settings mid-build', async () => {
    render()
    await act(async () => {
      await latest?.enable()
    })
    mocks.settings = { aiVaultSearch: { enabled: true, historyDays: null } }
    mocks.status = { ...unavailableSessionSearchStatus(), enabled: true, phase: 'indexing' }
    render()
    expect(latest?.stage).toBe('indexing')

    mocks.settings = { aiVaultSearch: { enabled: false, historyDays: null } }
    mocks.status = unavailableSessionSearchStatus()
    render()
    expect(latest?.stage).toBe('offer')
  })

  it('shows progress for a build turned on from Settings', () => {
    mocks.settings = { aiVaultSearch: { enabled: true, historyDays: null } }
    mocks.status = {
      ...unavailableSessionSearchStatus(),
      enabled: true,
      phase: 'indexing',
      filesIndexed: 4369,
      filesDue: 2951
    }
    render()
    expect(latest?.stage).toBe('indexing')
    expect(latest?.status?.filesIndexed).toBe(4369)
  })
})
