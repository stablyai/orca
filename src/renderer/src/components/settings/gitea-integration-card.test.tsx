// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GiteaConnectionStatus } from '../../../../shared/types'
import { GiteaTaskIntegrationCard } from './gitea-integration-card'

type StoreState = {
  giteaStatus: GiteaConnectionStatus | null
  giteaStatusLoaded: boolean
  refreshGiteaStatus: () => Promise<unknown>
  giteaDisconnect: (serverId?: string) => Promise<void>
  giteaTestConnection: (serverId?: string) => Promise<{ ok: boolean; error?: string }>
}

const mocks = vi.hoisted(() => ({
  store: { current: null as StoreState | null }
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: StoreState) => unknown) => {
    if (!mocks.store.current) {
      throw new Error('Store state was not installed')
    }
    return selector(mocks.store.current)
  }
}))

vi.mock('@/components/gitea-connect-dialog', () => ({
  GiteaConnectDialog: () => <div data-testid="gitea-connect-dialog" />
}))

let root: Root | null = null
let container: HTMLDivElement | null = null

function installStore(overrides: Partial<StoreState> = {}): StoreState {
  const state: StoreState = {
    giteaStatus: {
      connected: true,
      servers: [
        {
          id: 'srv-1',
          baseUrl: 'https://gitea.example.com',
          apiBaseUrl: 'https://gitea.example.com/api/v1',
          displayName: 'Acme Gitea',
          account: 'octocat'
        }
      ]
    },
    giteaStatusLoaded: true,
    refreshGiteaStatus: vi.fn(async () => null),
    giteaDisconnect: vi.fn(async () => {}),
    giteaTestConnection: vi.fn(async () => ({ ok: true })),
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
    root?.render(<GiteaTaskIntegrationCard />)
  })
  return container
}

function findButton(rendered: HTMLElement, label: string): HTMLButtonElement | undefined {
  return Array.from(rendered.querySelectorAll('button')).find(
    (button) => button.textContent?.trim() === label
  )
}

describe('GiteaTaskIntegrationCard', () => {
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

  it('lists connected servers and tests/disconnects a server', async () => {
    const state = installStore()

    const rendered = await renderCard()

    expect(rendered.textContent).toContain('1 server connected')
    expect(rendered.textContent).toContain('Acme Gitea')
    expect(rendered.textContent).toContain('https://gitea.example.com · octocat')

    await act(async () => {
      findButton(rendered, 'Test')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(state.giteaTestConnection).toHaveBeenCalledWith('srv-1')

    await act(async () => {
      rendered
        .querySelector<HTMLButtonElement>('button[aria-label="Disconnect Acme Gitea"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(state.giteaDisconnect).toHaveBeenCalledWith('srv-1')
  })

  it('surfaces a credential error', async () => {
    installStore({
      giteaStatus: {
        connected: true,
        servers: [],
        credentialError: 'Stored Gitea token could not be decrypted.'
      }
    })

    const rendered = await renderCard()

    expect(rendered.textContent).toContain('Stored Gitea token could not be decrypted.')
  })

  it('offers connect and re-check actions when not connected', async () => {
    const state = installStore({ giteaStatus: { connected: false } })

    const rendered = await renderCard()

    expect(findButton(rendered, 'Connect Gitea')).toBeDefined()

    await act(async () => {
      findButton(rendered, 'Re-check')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(state.refreshGiteaStatus).toHaveBeenCalledTimes(1)
  })

  it('shows a checking state while status is still loading', async () => {
    installStore({ giteaStatus: null, giteaStatusLoaded: false })

    const rendered = await renderCard()

    expect(rendered.textContent).toContain('Checking Gitea access')
    expect(findButton(rendered, 'Connect Gitea')).toBeUndefined()
  })
})
