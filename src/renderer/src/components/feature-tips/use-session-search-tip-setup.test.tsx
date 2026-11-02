// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { toast } from 'sonner'
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
  showAiVaultSearch: () => void
}

const mocks = vi.hoisted((): Mocks => ({
  settings: { aiVaultSearch: { enabled: false, historyDays: null } },
  status: null,
  updateSettingsOrThrow: async () => {},
  showAiVaultSearch: vi.fn()
}))

vi.mock('@/store', () => {
  const state = () => ({
    settings: mocks.settings,
    showAiVaultSearch: mocks.showAiVaultSearch,
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
let dialogOpen = true
function Probe(): null {
  latest = useSessionSearchTipSetup({ dialogOpen })
  return null
}

const container = document.createElement('div')
const root = createRoot(container)

afterEach(() => {
  act(() => root.render(null))
  mocks.settings = { aiVaultSearch: { enabled: false, historyDays: null } }
  mocks.status = null
  dialogOpen = true
  vi.mocked(toast.success).mockClear()
})

const indexing = (): AiVaultSearchStatus => ({
  ...unavailableSessionSearchStatus(),
  enabled: true,
  phase: 'indexing'
})
const ready = (): AiVaultSearchStatus => ({
  ...unavailableSessionSearchStatus(),
  enabled: true,
  phase: 'current',
  lastSweepCompletedAt: 1
})
const searchOn = { aiVaultSearch: { enabled: true, historyDays: null } }

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

  it('toasts once when a build the user closed mid-index finishes', () => {
    mocks.settings = searchOn
    mocks.status = indexing()
    render()
    dialogOpen = false
    render()
    expect(toast.success).not.toHaveBeenCalled()

    mocks.status = ready()
    render()
    render()
    expect(toast.success).toHaveBeenCalledTimes(1)
    expect(vi.mocked(toast.success).mock.calls[0][1]).toMatchObject({
      action: { label: 'Open', onClick: mocks.showAiVaultSearch }
    })
  })

  it('does not toast when another tip closes or the ready dialog closes', () => {
    mocks.settings = searchOn
    mocks.status = indexing()
    dialogOpen = false
    render()
    mocks.status = ready()
    render()
    expect(toast.success).not.toHaveBeenCalled()

    dialogOpen = true
    render()
    dialogOpen = false
    render()
    expect(toast.success).not.toHaveBeenCalled()
  })
})
