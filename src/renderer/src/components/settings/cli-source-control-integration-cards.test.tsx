// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getLocalExecutionHostLabel } from '../../../../shared/execution-host'
import {
  GitHubIntegrationCard,
  GitLabIntegrationCard
} from './cli-source-control-integration-cards'

type StoreState = {
  settings: { activeRuntimeEnvironmentId: string | null }
  openSettingsPage: () => void
  openSettingsTarget: (target: { pane: string; repoId: string | null }) => void
}

const mocks = vi.hoisted(() => ({
  store: { current: null as StoreState | null },
  preflight: {
    statuses: {
      ghStatus: 'connected',
      glabStatus: 'connected',
      bitbucketStatus: 'not-configured',
      azureDevOpsStatus: 'not-configured',
      giteaStatus: 'not-configured',
      bitbucketAccount: null,
      azureDevOpsAccount: null,
      giteaAccount: null
    },
    unavailable: false,
    refresh: vi.fn()
  }
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: StoreState) => unknown) => {
    if (!mocks.store.current) {
      throw new Error('Store state was not installed')
    }
    return selector(mocks.store.current)
  }
}))

vi.mock('./source-control-preflight-card-status', () => ({
  usePreflightCardStatuses: () => mocks.preflight
}))

let root: Root | null = null
let container: HTMLDivElement | null = null
const localHostLabel = getLocalExecutionHostLabel()

async function renderCard(card: React.ReactNode): Promise<HTMLDivElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(card)
  })
  return container
}

describe('CLI source-control integration card account scope', () => {
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
    mocks.preflight.statuses.ghStatus = 'connected'
    mocks.preflight.statuses.glabStatus = 'connected'
    mocks.preflight.unavailable = false
    mocks.preflight.refresh.mockClear()
  })

  it('shows local-client ownership for connected GitHub CLI credentials', async () => {
    const openSettingsPage = vi.fn()
    const openSettingsTarget = vi.fn()
    mocks.store.current = {
      settings: { activeRuntimeEnvironmentId: null },
      openSettingsPage,
      openSettingsTarget
    }

    const rendered = await renderCard(<GitHubIntegrationCard />)

    expect(rendered.textContent).toContain('GitHub')
    expect(rendered.textContent).toContain('Connected')
    expect(rendered.textContent).toContain(`Account scope: ${localHostLabel}`)
    expect(rendered.textContent).toContain(
      'Credentials and account checks for this provider are owned by this desktop client. Use Settings > Remote Orca Servers > Advanced to edit server-owned credentials.'
    )
    await act(async () => {
      Array.from(rendered.querySelectorAll('button'))
        .find((button) => button.textContent === 'Open Remote Servers')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(openSettingsPage).toHaveBeenCalledTimes(1)
    expect(openSettingsTarget).toHaveBeenCalledWith({
      pane: 'servers',
      repoId: null,
      sectionId: 'default-runtime'
    })
  })

  it('shows remote-server ownership for GitLab CLI credential checks', async () => {
    mocks.store.current = {
      settings: { activeRuntimeEnvironmentId: 'runtime-1' },
      openSettingsPage: vi.fn(),
      openSettingsTarget: vi.fn()
    }
    mocks.preflight.statuses.glabStatus = 'not-authenticated'

    const rendered = await renderCard(<GitLabIntegrationCard />)

    expect(rendered.textContent).toContain('GitLab')
    expect(rendered.textContent).toContain('Account scope: Remote server: runtime-1')
    expect(rendered.textContent).toContain(
      'Credentials and account checks for this provider are owned by this remote server. Use Settings > Remote Orca Servers > Advanced to edit another default runtime scope.'
    )
    expect(rendered.textContent).toContain('glab auth login')
  })
})
