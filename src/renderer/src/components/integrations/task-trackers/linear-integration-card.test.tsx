// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { i18n, loadRendererUiLanguage } from '@/i18n/i18n'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import { TooltipProvider } from '../../ui/tooltip'
import { LinearIntegrationCard } from './linear-integration-card'

type StoreState = {
  linearStatus: {
    connected: boolean
    workspaces?: { id: string; organizationName: string; displayName: string; email?: string }[]
  }
  linearStatusChecked: boolean
  linearStatusContextKey: string | null
  disconnectLinear: () => Promise<void>
  disconnectLinearWorkspace: (workspaceId?: string) => Promise<void>
  checkLinearConnection: (force?: boolean) => Promise<void>
  testLinearConnection: (workspaceId: string) => Promise<{ ok: boolean; error?: string }>
  settings: { activeRuntimeEnvironmentId: string | null }
  openSettingsPage: () => void
  openSettingsTarget: (target: { pane: string; repoId: string | null }) => void
}

const mocks = vi.hoisted(() => ({
  store: { current: null as StoreState | null }
}))

vi.mock('@/store/index', () => ({
  useAppStore: Object.assign(
    (selector: (state: StoreState) => unknown) => {
      if (!mocks.store.current) {
        throw new Error('Store state was not installed')
      }
      return selector(mocks.store.current)
    },
    { getState: () => mocks.store.current }
  )
}))

vi.mock('@/components/linear-api-key-dialog', () => ({
  LinearApiKeyDialog: ({ onConnected }: { onConnected?: () => void }) => (
    <button type="button" data-testid="simulate-linear-connected" onClick={onConnected}>
      Simulate Linear connected
    </button>
  )
}))

let root: Root | null = null
let container: HTMLDivElement | null = null

function installStore(
  connected: boolean,
  settings: StoreState['settings'] = { activeRuntimeEnvironmentId: null }
): StoreState {
  const state: StoreState = {
    linearStatus: {
      connected,
      workspaces: connected
        ? [
            {
              id: 'workspace-1',
              organizationName: 'Acme',
              displayName: 'Acme workspace',
              email: 'linear@example.test'
            }
          ]
        : []
    },
    linearStatusChecked: true,
    linearStatusContextKey: getProviderRuntimeContextKey(settings),
    disconnectLinear: vi.fn(async () => {}),
    disconnectLinearWorkspace: vi.fn(async () => {}),
    checkLinearConnection: vi.fn(async () => {}),
    testLinearConnection: vi.fn(async () => ({ ok: true })),
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
    root?.render(
      <TooltipProvider>
        <LinearIntegrationCard />
      </TooltipProvider>
    )
  })
  return container
}

describe('LinearIntegrationCard account scope', () => {
  beforeEach(() => {
    // Stub the skill scan so the CTA renders setup state rather than a bridge error.
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        skills: { discover: async () => ({ skills: [], sources: [], scannedAt: 0 }) }
      }
    })
  })

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
    await i18n.changeLanguage(await loadRendererUiLanguage('en'))
    Reflect.deleteProperty(window, 'api')
  })

  it('clears verification state after adding another Linear workspace', async () => {
    installStore(true)
    const rendered = await renderCard()

    await act(async () => {
      Array.from(rendered.querySelectorAll('button'))
        .find((button) => button.textContent === 'Test')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(rendered.textContent).toContain('Verified')

    await act(async () => {
      rendered
        .querySelector<HTMLButtonElement>('[data-testid="simulate-linear-connected"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(rendered.textContent).not.toContain('Verified')
  })
})
