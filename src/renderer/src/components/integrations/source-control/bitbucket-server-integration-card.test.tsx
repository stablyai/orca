// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  disconnect: vi.fn(async () => {})
}))

vi.mock('./bitbucket-server-credentials-dialog', () => ({
  BitbucketServerCredentialsDialog: ({ open }: { open: boolean }) =>
    open ? <div>Server dialog open</div> : null
}))

import { BitbucketServerIntegrationCard } from './bitbucket-server-integration-card'

let container: HTMLDivElement
let root: Root

async function renderCard(): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(<BitbucketServerIntegrationCard />)
  })
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent === label
  )
}

describe('BitbucketServerIntegrationCard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.assign(window, {
      api: {
        bitbucketServer: { status: mocks.status, disconnect: mocks.disconnect },
        shell: { openUrl: vi.fn() }
      }
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('offers Connect when nothing is configured', async () => {
    mocks.status.mockResolvedValue({
      configured: false,
      source: 'none',
      credentialProtection: null,
      account: null,
      baseUrl: null
    })

    await renderCard()

    expect(container.textContent).toContain('Bitbucket Data Center')
    expect(container.textContent).toContain(
      'Pull requests and build statuses for Bitbucket Data Center and Server.'
    )
    await act(async () => {
      button('Connect')?.click()
    })
    expect(container.textContent).toContain('Server dialog open')
  })

  it('shows the account and server and disconnects a stored credential', async () => {
    mocks.status.mockResolvedValue({
      configured: true,
      source: 'stored',
      credentialProtection: 'sealed',
      account: 'alice',
      baseUrl: 'https://bitbucket.example.com'
    })

    await renderCard()

    expect(container.textContent).toContain('alice')
    expect(container.textContent).toContain('https://bitbucket.example.com')
    await act(async () => {
      button('Disconnect')?.click()
    })
    expect(mocks.disconnect).toHaveBeenCalledOnce()
  })

  it('does not offer Disconnect for environment credentials', async () => {
    mocks.status.mockResolvedValue({
      configured: true,
      source: 'environment',
      credentialProtection: null,
      account: null,
      baseUrl: 'https://bitbucket.example.com'
    })

    await renderCard()

    expect(button('Disconnect')).toBeUndefined()
    expect(container.textContent).toContain('ORCA_BITBUCKET_SERVER_TOKEN')
  })

  it('says the credential could not be read when status fails', async () => {
    mocks.status.mockRejectedValue(new Error('keychain locked'))

    await renderCard()

    expect(container.textContent).toContain(
      'Could not check for a saved Bitbucket Server credential.'
    )
  })
})
