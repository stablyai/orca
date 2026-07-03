// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import { JiraIntegrationCard } from './jira-integration-card'

type StoreState = {
  jiraStatus: {
    connected: boolean
    sites?: {
      id: string
      displayName: string
      siteUrl: string
      email?: string
      deploymentType?: 'cloud' | 'server'
      authUsername?: string
    }[]
  }
  jiraStatusChecked: boolean
  jiraStatusContextKey: string | null
  checkJiraConnection: () => Promise<void>
  disconnectJira: (siteId?: string) => Promise<void>
  testJiraConnection: (siteId: string) => Promise<{ ok: boolean; error?: string }>
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

vi.mock('@/components/jira-connect-dialog', () => ({
  JiraConnectDialog: ({ onConnected }: { onConnected?: () => void }) => (
    <button type="button" data-testid="simulate-jira-connected" onClick={onConnected}>
      Simulate Jira connected
    </button>
  )
}))

let root: Root | null = null
let container: HTMLDivElement | null = null

function installStore(settings: StoreState['settings']): StoreState {
  const state: StoreState = {
    jiraStatus: {
      connected: true,
      sites: [
        {
          id: 'site-1',
          displayName: 'Acme Jira',
          siteUrl: 'https://acme.atlassian.net',
          email: 'jira@example.test'
        }
      ]
    },
    jiraStatusChecked: true,
    jiraStatusContextKey: getProviderRuntimeContextKey(settings),
    checkJiraConnection: vi.fn(async () => {}),
    disconnectJira: vi.fn(async () => {}),
    testJiraConnection: vi.fn(async () => ({ ok: true })),
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
    root?.render(<JiraIntegrationCard />)
  })
  return container
}

describe('JiraIntegrationCard account scope', () => {
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

    expect(rendered.textContent).toContain('Account scope: Remote server: runtime-1')
    expect(rendered.textContent).toContain('Acme Jira')
    expect(rendered.textContent).toContain('https://acme.atlassian.net · jira@example.test')

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

  it('describes Jira Cloud and Server/Data Center setup when disconnected', async () => {
    const state = installStore({ activeRuntimeEnvironmentId: null })
    state.jiraStatus = { connected: false }

    const rendered = await renderCard()

    expect(rendered.textContent).toContain('Browse, create, and start work from Jira issues.')
    expect(rendered.textContent).toContain('Connect a Jira Cloud or Server/Data Center site.')
    expect(rendered.textContent).not.toContain('Connect a Jira Cloud site')
  })

  it('shows Server/Data Center auth username instead of Cloud email labels', async () => {
    const state = installStore({ activeRuntimeEnvironmentId: null })
    state.jiraStatus.sites = [
      {
        id: 'server-1',
        displayName: 'Internal Jira',
        siteUrl: 'https://jira.example.internal',
        email: 'ada@example.internal',
        deploymentType: 'server',
        authUsername: 'ada'
      }
    ]

    const rendered = await renderCard()

    expect(rendered.textContent).toContain('https://jira.example.internal · ada')
    expect(rendered.textContent).not.toContain(
      'https://jira.example.internal · ada@example.internal'
    )
  })
})
