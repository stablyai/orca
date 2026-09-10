// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import { OdooIntegrationCard } from './odoo-integration-card'

type StoreState = {
  odooStatus: {
    connected: boolean
    viewer: null
    instances?: { id: string; serverUrl: string; database: string; login: string }[]
    credentialError?: string
  }
  odooStatusChecked: boolean
  odooStatusContextKey: string | null
  checkOdooConnection: () => Promise<void>
  disconnectOdoo: (instanceId?: string) => Promise<void>
  testOdooConnection: (instanceId: string) => Promise<{ ok: boolean; error?: string }>
  settings: { activeRuntimeEnvironmentId: string | null }
  openSettingsPage: () => void
  openSettingsTarget: (target: { pane: string; repoId: string | null }) => void
}

const mocks = vi.hoisted(() => ({
  store: { current: null as StoreState | null },
  toastError: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: StoreState) => unknown) => {
    if (!mocks.store.current) {
      throw new Error('Store state was not installed')
    }
    return selector(mocks.store.current)
  }
}))

vi.mock('sonner', () => ({
  toast: { error: mocks.toastError }
}))

vi.mock('@/components/odoo-connect-dialog', () => ({
  OdooConnectDialog: () => null
}))

let root: Root | null = null
let container: HTMLDivElement | null = null

function installStore(overrides: Partial<StoreState> = {}): StoreState {
  const settings = overrides.settings ?? { activeRuntimeEnvironmentId: null }
  const state: StoreState = {
    odooStatus: {
      connected: true,
      viewer: null,
      instances: [
        {
          id: 'inst-1',
          serverUrl: 'https://odoo.example.test',
          database: 'prod',
          login: 'dev@example.test'
        }
      ]
    },
    odooStatusChecked: true,
    odooStatusContextKey: getProviderRuntimeContextKey(settings),
    checkOdooConnection: vi.fn(async () => {}),
    disconnectOdoo: vi.fn(async () => {}),
    testOdooConnection: vi.fn(async () => ({ ok: true })),
    settings,
    openSettingsPage: vi.fn(),
    openSettingsTarget: vi.fn(),
    ...overrides
  }
  mocks.store.current = state
  return state
}

async function renderCard(): Promise<HTMLDivElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(<OdooIntegrationCard />)
  })
  return container
}

describe('OdooIntegrationCard', () => {
  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount()
      })
    }
    root = null
    container?.remove()
    container = null
    mocks.store.current = null
    mocks.toastError.mockReset()
  })

  it('renders a localized status label', async () => {
    installStore()

    const rendered = await renderCard()

    expect(rendered.textContent).toContain('Connected')
  })

  it('renders a localized status label while disconnected', async () => {
    installStore({ odooStatus: { connected: false, viewer: null } })

    const rendered = await renderCard()

    expect(rendered.textContent).toContain('Not connected')
  })

  it('surfaces a failed disconnect instead of dropping the rejection', async () => {
    const state = installStore({
      disconnectOdoo: vi.fn(async () => {
        throw new Error('runtime unreachable')
      })
    })

    const rendered = await renderCard()
    const disconnect = rendered.querySelector<HTMLButtonElement>(
      'button[aria-label="Disconnect prod"]'
    )
    expect(disconnect).not.toBeNull()

    await act(async () => {
      disconnect?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(state.disconnectOdoo).toHaveBeenCalledWith('inst-1')
    expect(mocks.toastError).toHaveBeenCalledWith('Could not disconnect Odoo.', {
      description: 'runtime unreachable'
    })
  })
})
