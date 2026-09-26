// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import { BusinessmapIntegrationCard } from './businessmap-integration-card'

type StoreState = {
  businessmapStatus: {
    connected: boolean
    sites?: { id: string; subdomain: string; domain: string; displayName?: string }[]
  }
  businessmapStatusChecked: boolean
  businessmapStatusContextKey: string | null
  checkBusinessmapConnection: () => Promise<void>
  disconnectBusinessmap: (siteId?: string | null) => Promise<void>
  testBusinessmapConnection: (siteId?: string | null) => Promise<{ ok: boolean; error?: string }>
  settings: { activeRuntimeEnvironmentId: string | null }
  openSettingsPage: () => void
  openSettingsTarget: (target: { pane: string; repoId: string | null }) => void
}

const mocks = vi.hoisted((): { store: { current: StoreState | null } } => ({
  store: { current: null }
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: StoreState) => unknown) => {
    if (!mocks.store.current) {
      throw new Error('Store state was not installed')
    }
    return selector(mocks.store.current)
  }
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

let root: Root | null = null
let container: HTMLDivElement | null = null

function installStore(settings: StoreState['settings']): StoreState {
  const state: StoreState = {
    businessmapStatus: {
      connected: true,
      sites: [
        {
          id: 'site-1',
          subdomain: 'acme',
          domain: 'businessmap.io',
          displayName: 'Acme Businessmap'
        }
      ]
    },
    businessmapStatusChecked: true,
    businessmapStatusContextKey: getProviderRuntimeContextKey(settings),
    checkBusinessmapConnection: vi.fn(async () => {}),
    disconnectBusinessmap: vi.fn(async () => {}),
    testBusinessmapConnection: vi.fn(async () => ({ ok: true })),
    settings,
    openSettingsPage: vi.fn(),
    openSettingsTarget: vi.fn()
  }
  mocks.store.current = state
  return state
}

async function renderCard(): Promise<HTMLDivElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(<BusinessmapIntegrationCard />)
  })
  return container
}

describe('BusinessmapIntegrationCard account scope', () => {
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
  })

  it('shows remote-server account ownership and opens Hosts settings', async () => {
    const state = installStore({ activeRuntimeEnvironmentId: 'runtime-1' })

    const rendered = await renderCard()

    expect(
      rendered.querySelector('[data-settings-section="integrations-businessmap"]')
    ).not.toBeNull()
    expect(rendered.textContent).toContain('Account scope: Remote server: runtime-1')
    expect(rendered.textContent).toContain('Acme Businessmap')
    expect(rendered.textContent).toContain('acme.businessmap.io')

    await act(async () => {
      Array.from(rendered.querySelectorAll('button'))
        .find((button) => button.textContent === 'Open Remote Servers')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(state.openSettingsPage).toHaveBeenCalledTimes(1)
    expect(state.openSettingsTarget).toHaveBeenCalledWith({
      pane: 'servers',
      repoId: null,
      sectionId: 'default-runtime'
    })
  })
})
