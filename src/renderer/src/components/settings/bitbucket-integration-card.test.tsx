// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  status: vi.fn(),
  statuses: { bitbucketStatus: 'not-authenticated', bitbucketAccount: null }
}))

vi.mock('./source-control-preflight-card-status', () => ({
  usePreflightCardStatuses: () => ({
    statuses: mocks.statuses,
    unavailable: false,
    refresh: mocks.refresh
  })
}))
vi.mock('./bitbucket-credentials-dialog', () => ({
  BitbucketCredentialsDialog: ({ open, initialEmail }: { open: boolean; initialEmail?: string }) =>
    open ? <div>Credential dialog open {initialEmail}</div> : null
}))

import { BitbucketIntegrationCard } from './bitbucket-integration-card'

const LOAD_FAILED_TEXT = 'Could not check for a saved Bitbucket credential.'

let container: HTMLDivElement
let root: Root

async function renderCard(): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(<BitbucketIntegrationCard />)
  })
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
    mocks.statuses = { bitbucketStatus: 'not-authenticated', bitbucketAccount: null }
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
    let rejectInitial!: (error: Error) => void
    mocks.status
      .mockReturnValueOnce(
        new Promise((_resolve, reject) => {
          rejectInitial = reject
        })
      )
      .mockResolvedValueOnce({ source: 'none', account: null })

    await renderCard()
    await act(async () => {
      recheckButton().click()
    })
    await act(async () => {
      rejectInitial(new Error('late keychain failure'))
    })

    expect(container.textContent).not.toContain(LOAD_FAILED_TEXT)
  })

  it('does not expose stale credential controls after a re-check fails', async () => {
    mocks.statuses = { bitbucketStatus: 'connected', bitbucketAccount: null }
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
