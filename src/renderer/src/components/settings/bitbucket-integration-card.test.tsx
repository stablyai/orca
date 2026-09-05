// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreflightIntegrationStatuses } from './integrations-pane-status'
import { BitbucketIntegrationCard } from './bitbucket-integration-card'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  statuses: { current: null as PreflightIntegrationStatuses | null }
}))

vi.mock('./source-control-preflight-card-status', () => ({
  usePreflightCardStatuses: () => {
    if (!mocks.statuses.current) {
      throw new Error('Preflight statuses were not installed')
    }
    return { statuses: mocks.statuses.current, unavailable: false, refresh: vi.fn() }
  }
}))

let root: Root | null = null
let container: HTMLDivElement | null = null

function installStatuses(bitbucket: {
  bitbucketStatus: PreflightIntegrationStatuses['bitbucketStatus']
  bitbucketAccount: string | null
  bitbucketBaseUrl: string | null
}): void {
  mocks.statuses.current = {
    ghStatus: 'connected',
    glabStatus: 'connected',
    azureDevOpsStatus: 'not-configured',
    azureDevOpsAccount: null,
    azureDevOpsBaseUrl: null,
    giteaStatus: 'not-configured',
    giteaAccount: null,
    giteaBaseUrl: null,
    ...bitbucket
  }
}

async function renderCard(): Promise<HTMLDivElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(<BitbucketIntegrationCard />)
  })
  return container
}

describe('BitbucketIntegrationCard', () => {
  beforeEach(() => {
    // The card reads stored-credential metadata on mount; no saved credential
    // here, so only the preflight-driven parts render.
    Object.assign(window, {
      api: { bitbucket: { status: vi.fn().mockResolvedValue(null), disconnect: vi.fn() } }
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
    mocks.statuses.current = null
  })

  it('documents the Data Center environment variables when unconfigured', async () => {
    installStatuses({
      bitbucketStatus: 'not-configured',
      bitbucketAccount: null,
      bitbucketBaseUrl: null
    })

    const rendered = await renderCard()

    expect(rendered.textContent).toContain('ORCA_BITBUCKET_SERVER_URL')
    expect(rendered.textContent).toContain('ORCA_BITBUCKET_SERVER_TOKEN')
    // Cloud keeps its Connect flow; the env vars are named generically there.
    expect(rendered.textContent).toContain('ORCA_BITBUCKET_*')
  })

  // Why: a Data Center token has no account name until a request carries
  // X-AUSERNAME, so the site base URL is the only identifying detail available.
  it('identifies a connected Data Center site by its base URL when no account is known', async () => {
    installStatuses({
      bitbucketStatus: 'connected',
      bitbucketAccount: null,
      bitbucketBaseUrl: 'https://bb.corp.example/bitbucket'
    })

    const rendered = await renderCard()

    expect(rendered.textContent).toContain('https://bb.corp.example/bitbucket')
    expect(rendered.textContent).toContain('Connected')
  })

  it('prefers the account name over the base URL once one is known', async () => {
    installStatuses({
      bitbucketStatus: 'connected',
      bitbucketAccount: 'j.smith',
      bitbucketBaseUrl: 'https://bb.corp.example/bitbucket'
    })

    const rendered = await renderCard()

    expect(rendered.textContent).toContain('j.smith · Pull requests and build statuses')
    expect(rendered.textContent).not.toContain('https://bb.corp.example/bitbucket')
  })
})
