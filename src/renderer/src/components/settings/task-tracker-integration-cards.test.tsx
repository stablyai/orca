// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getLocalExecutionHostLabel } from '../../../../shared/execution-host'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import { LinearIntegrationCard } from './task-tracker-integration-cards'

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

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: StoreState) => unknown) => {
    if (!mocks.store.current) {
      throw new Error('Store state was not installed')
    }
    return selector(mocks.store.current)
  }
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
const localHostLabel = getLocalExecutionHostLabel()

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
    root?.render(<LinearIntegrationCard />)
  })
  return container
}

describe('LinearIntegrationCard account scope', () => {
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

  it('shows local-client account ownership when Linear is disconnected', async () => {
    const state = installStore(false)

    const rendered = await renderCard()

    expect(rendered.textContent).toContain(`Account scope: ${localHostLabel}`)
    expect(rendered.textContent).toContain(
      'Credentials and account checks for this provider are owned by this desktop client. Use Settings > Remote Orca Servers > Advanced to edit server-owned credentials.'
    )
    expect(rendered.textContent).toContain('Open Remote Servers')
    expect(rendered.textContent).toContain('Add access with a Personal API key')

    await act(async () => {
      Array.from(rendered.querySelectorAll('button'))
        .find((button) => button.textContent === 'Re-check')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(state.checkLinearConnection).toHaveBeenCalledWith(true)
  })

  it('shows remote-server account ownership and connected workspace rows', async () => {
    const state = installStore(true, { activeRuntimeEnvironmentId: 'runtime-1' })

    const rendered = await renderCard()

    expect(rendered.textContent).toContain('Account scope: Remote server: runtime-1')
    expect(rendered.textContent).toContain(
      'Credentials and account checks for this provider are owned by this remote server. Use Settings > Remote Orca Servers > Advanced to edit another default runtime scope.'
    )
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
    expect(rendered.textContent).toContain('Acme')
    expect(rendered.textContent).toContain('Acme workspace · linear@example.test')

    await act(async () => {
      Array.from(rendered.querySelectorAll('button'))
        .find((button) => button.textContent === 'Test')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(state.testLinearConnection).toHaveBeenCalledWith('workspace-1')
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
