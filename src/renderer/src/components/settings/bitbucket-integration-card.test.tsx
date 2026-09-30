// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreflightIntegrationStatuses } from './integrations-pane-status'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  status: vi.fn(),
  statuses: { current: null as PreflightIntegrationStatuses | null }
}))

vi.mock('./source-control-preflight-card-status', () => ({
  usePreflightCardStatuses: () => {
    if (!mocks.statuses.current) {
      throw new Error('Preflight statuses were not installed')
    }
    return { statuses: mocks.statuses.current, unavailable: false, refresh: mocks.refresh }
  }
}))
vi.mock('./bitbucket-credentials-dialog', () => ({
  BitbucketCredentialsDialog: ({ open, initialEmail }: { open: boolean; initialEmail?: string }) =>
    open ? <div>Credential dialog open {initialEmail}</div> : null
}))

import { BitbucketIntegrationCard } from './bitbucket-integration-card'

const LOAD_FAILED_TEXT = 'Could not check for a saved Bitbucket credential.'

let container: HTMLDivElement
let root: Root

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
    root.render(<BitbucketIntegrationCard />)
  })
  return container
}

function recheckButton(): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent === 'Re-check'
  )
  if (!button) {
    throw new Error('Re-check button not rendered')
  }
  return button
}

describe('BitbucketIntegrationCard credential-read failures', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    installStatuses({
      bitbucketStatus: 'not-authenticated',
      bitbucketAccount: null,
      bitbucketBaseUrl: null
    })
    Object.assign(window, {
      api: {
        bitbucket: { status: mocks.status, disconnect: vi.fn(async () => {}) },
        shell: { openUrl: vi.fn() }
      }
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    mocks.statuses.current = null
  })

  it('says the credential could not be read rather than rendering as "nothing stored"', async () => {
    mocks.status.mockRejectedValue(new Error('keychain locked'))

    await renderCard()

    expect(container.textContent).toContain(LOAD_FAILED_TEXT)
    expect(container.textContent).not.toContain('Connect')
    expect(container.textContent).toContain('Add or replace credentials')
    expect(container.textContent).not.toContain('credentials are configured')

    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'Add or replace credentials')
        ?.click()
    })
    expect(container.textContent).toContain('Credential dialog open')
  })

  it('does not claim a read failure when the status resolves', async () => {
    mocks.status.mockResolvedValue({ source: 'none', account: null })

    await renderCard()

    expect(container.textContent).not.toContain(LOAD_FAILED_TEXT)
  })

  it('retries the failed credential read from Re-check, not just the preflight', async () => {
    mocks.status.mockRejectedValueOnce(new Error('keychain locked'))
    mocks.status.mockResolvedValueOnce({ source: 'none', account: null })

    await renderCard()
    expect(container.textContent).toContain(LOAD_FAILED_TEXT)

    await act(async () => {
      recheckButton().click()
    })

    expect(mocks.status).toHaveBeenCalledTimes(2)
    expect(mocks.refresh).toHaveBeenCalled()
    expect(container.textContent).not.toContain(LOAD_FAILED_TEXT)
  })

  it('does not let an older failed read overwrite a newer successful re-check', async () => {
    const initial = Promise.withResolvers<{ source: string; account: string | null }>()
    mocks.status
      .mockReturnValueOnce(initial.promise)
      .mockResolvedValueOnce({ source: 'none', account: null })

    await renderCard()
    await act(async () => {
      recheckButton().click()
    })
    await act(async () => {
      initial.reject(new Error('late keychain failure'))
    })

    expect(container.textContent).not.toContain(LOAD_FAILED_TEXT)
  })

  it('does not expose stale credential controls after a re-check fails', async () => {
    installStatuses({ bitbucketStatus: 'connected', bitbucketAccount: null, bitbucketBaseUrl: null })
    mocks.status
      .mockResolvedValueOnce({
        configured: true,
        source: 'stored',
        account: 'stale-account',
        authMode: 'token',
        email: 'stale@example.com',
        baseUrl: null
      })
      .mockRejectedValueOnce(new Error('keychain locked'))

    await renderCard()
    expect(container.textContent).toContain('stale-account')
    expect(container.textContent).toContain('Edit credentials')
    expect(container.querySelector('[aria-label="Disconnect Bitbucket"]')).not.toBeNull()

    await act(async () => {
      recheckButton().click()
    })

    expect(container.textContent).toContain(LOAD_FAILED_TEXT)
    expect(container.textContent).not.toContain('stale-account')
    expect(container.textContent).not.toContain('Edit credentials')
    expect(container.textContent).toContain('Add or replace credentials')
    expect(container.querySelector('[aria-label="Disconnect Bitbucket"]')).toBeNull()

    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'Add or replace credentials')
        ?.click()
    })
    expect(container.textContent).toContain('Credential dialog open')
    expect(container.textContent).not.toContain('stale@example.com')
  })
})

describe('BitbucketIntegrationCard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // The card reads stored-credential metadata on mount; no saved credential
    // here, so only the preflight-driven parts render.
    mocks.status.mockResolvedValue(null)
    Object.assign(window, {
      api: { bitbucket: { status: mocks.status, disconnect: vi.fn() } }
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    mocks.statuses.current = null
  })

  it('documents the Data Center environment variables once the credential state is known', async () => {
    installStatuses({
      bitbucketStatus: 'not-configured',
      bitbucketAccount: null,
      bitbucketBaseUrl: null
    })
    // The env-var guidance note only renders after the stored-credential probe
    // resolves; main gates it behind a known credential state (non-null status).
    mocks.status.mockResolvedValue({ source: 'none', account: null })

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
