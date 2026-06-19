// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GlpiConnectionStatus, GlpiServer } from '../../../../shared/types'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import { GlpiTaskIntegrationCard } from './glpi-integration-card'

type StoreState = {
  glpiStatus: GlpiConnectionStatus
  glpiStatusChecked: boolean
  glpiStatusContextKey: string | null
  checkGlpiConnection: () => Promise<void>
  disconnectGlpi: (serverId?: string) => Promise<void>
  testGlpiConnection: (serverId?: string) => Promise<{ ok: boolean; error?: string }>
  selectGlpiServer: (serverId: string) => Promise<void>
  settings: { activeRuntimeEnvironmentId: string | null }
  openSettingsPage: () => void
  openSettingsTarget: (target: { pane: string; repoId: string | null }) => void
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

vi.mock('@/components/glpi-connect-dialog', () => ({
  GlpiConnectDialog: ({ onConnected }: { onConnected?: () => void }) => (
    <button type="button" data-testid="simulate-glpi-connected" onClick={onConnected}>
      Simulate GLPI connected
    </button>
  )
}))

const server: GlpiServer = {
  id: 'srv-1',
  baseUrl: 'https://glpi.example.com',
  apiBaseUrl: 'https://glpi.example.com/apirest.php',
  displayName: 'Acme GLPI',
  account: 'octocat'
}

let root: Root | null = null
let container: HTMLDivElement | null = null

function installStore(
  settings: StoreState['settings'],
  statusOverrides: Partial<GlpiConnectionStatus> = {}
): StoreState {
  const state: StoreState = {
    glpiStatus: {
      connected: true,
      viewer: { id: 1, login: 'octocat', fullName: 'Octo Cat' },
      servers: [server],
      selectedServerId: 'srv-1',
      ...statusOverrides
    },
    glpiStatusChecked: true,
    glpiStatusContextKey: getProviderRuntimeContextKey(settings),
    checkGlpiConnection: vi.fn(async () => {}),
    disconnectGlpi: vi.fn(async () => {}),
    testGlpiConnection: vi.fn(async () => ({ ok: true })),
    selectGlpiServer: vi.fn(async () => {}),
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
    root?.render(<GlpiTaskIntegrationCard />)
  })
  return container
}

function findButtonByText(scope: HTMLElement, text: string): HTMLButtonElement | undefined {
  return Array.from(scope.querySelectorAll('button')).find(
    (button) => button.textContent?.trim() === text
  ) as HTMLButtonElement | undefined
}

describe('GlpiTaskIntegrationCard', () => {
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

  it('renders the connected server with display name, base URL, and account', async () => {
    installStore({ activeRuntimeEnvironmentId: null })

    const rendered = await renderCard()

    expect(rendered.textContent).toContain('Acme GLPI')
    expect(rendered.textContent).toContain('https://glpi.example.com · octocat')
  })

  it('calls testGlpiConnection when the Test button is clicked', async () => {
    const state = installStore({ activeRuntimeEnvironmentId: null })

    const rendered = await renderCard()

    await act(async () => {
      findButtonByText(rendered, 'Test')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(state.testGlpiConnection).toHaveBeenCalledWith('srv-1')
  })

  it('calls disconnectGlpi when the per-server disconnect button is clicked', async () => {
    const state = installStore({ activeRuntimeEnvironmentId: null })

    const rendered = await renderCard()

    await act(async () => {
      rendered
        .querySelector<HTMLButtonElement>('button[aria-label="Disconnect Acme GLPI"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(state.disconnectGlpi).toHaveBeenCalledWith('srv-1')
  })

  it('renders the credential error when present', async () => {
    installStore(
      { activeRuntimeEnvironmentId: null },
      { credentialError: 'Could not decrypt saved GLPI credential.' }
    )

    const rendered = await renderCard()

    expect(rendered.textContent).toContain('Could not decrypt saved GLPI credential.')
  })

  it('shows the remote-server account scope when a runtime is active', async () => {
    installStore({ activeRuntimeEnvironmentId: 'runtime-1' })

    const rendered = await renderCard()

    expect(rendered.textContent).toContain('Remote server: runtime-1')
    expect(rendered.textContent).toContain('Acme GLPI')
  })
})
