// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getLocalExecutionHostLabel } from '../../../../shared/execution-host'
import type { BitbucketConnectionStatus } from '../../../../shared/bitbucket-credentials'
import { BitbucketIntegrationCard } from './bitbucket-integration-card'

const storedConnection: BitbucketConnectionStatus = {
  configured: true,
  source: 'stored',
  account: 'bitbucket-user',
  authMode: 'token',
  email: null,
  baseUrl: null
}

const disconnectedConnection: BitbucketConnectionStatus = {
  configured: false,
  source: 'none',
  account: null,
  authMode: null,
  email: null,
  baseUrl: null
}

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(async () => true),
  disconnect: vi.fn(async () => {}),
  refresh: vi.fn(),
  status: vi.fn<() => Promise<BitbucketConnectionStatus>>(),
  toastError: vi.fn(),
  toastSuccess: vi.fn()
}))

vi.mock('@/components/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => mocks.confirm
}))

vi.mock('sonner', () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess }
}))

vi.mock('./bitbucket-credentials-dialog', () => ({
  BitbucketCredentialsDialog: () => null
}))

vi.mock('./source-control-preflight-card-status', () => ({
  usePreflightCardStatuses: () => ({
    statuses: {
      bitbucketStatus: 'connected',
      bitbucketAccount: 'bitbucket-user'
    },
    unavailable: false,
    refresh: mocks.refresh
  })
}))

let root: Root | null = null
let container: HTMLDivElement | null = null

async function renderCard(): Promise<HTMLDivElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(<BitbucketIntegrationCard />)
  })
  return container
}

describe('BitbucketIntegrationCard removal', () => {
  beforeEach(() => {
    mocks.status.mockResolvedValueOnce(storedConnection).mockResolvedValue(disconnectedConnection)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        bitbucket: {
          disconnect: mocks.disconnect,
          status: mocks.status
        },
        shell: { openUrl: vi.fn() }
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
    mocks.confirm.mockClear()
    mocks.disconnect.mockClear()
    mocks.refresh.mockClear()
    mocks.toastError.mockClear()
    mocks.toastSuccess.mockClear()
    mocks.status.mockReset()
    Reflect.deleteProperty(window, 'api')
  })

  it('removes the stored credential after destructive confirmation', async () => {
    const rendered = await renderCard()
    expect(rendered.textContent).toContain('Edit credentials')
    expect(rendered.textContent).toContain('Remove')

    await act(async () => {
      Array.from(rendered.querySelectorAll('button'))
        .find((button) => button.textContent === 'Remove')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mocks.confirm).toHaveBeenCalledWith({
      title: 'Remove Bitbucket integration?',
      description: `Orca will delete its saved credentials for this integration from ${getLocalExecutionHostLabel()}. Credentials issued by Bitbucket will not be revoked.`,
      confirmLabel: 'Remove',
      confirmVariant: 'destructive'
    })
    expect(mocks.disconnect).toHaveBeenCalledTimes(1)
    expect(mocks.refresh).toHaveBeenCalledTimes(1)
    expect(rendered.textContent).not.toContain('Remove')
  })

  it('reports credential removal failures and keeps the integration connected', async () => {
    mocks.disconnect.mockRejectedValueOnce(new Error('Keychain is locked'))
    const rendered = await renderCard()

    await act(async () => {
      Array.from(rendered.querySelectorAll('button'))
        .find((button) => button.textContent === 'Remove')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mocks.toastError).toHaveBeenCalledWith('Could not remove the Bitbucket integration.', {
      description: 'Keychain is locked'
    })
    expect(mocks.refresh).not.toHaveBeenCalled()
    expect(rendered.textContent).toContain('Remove')
  })
})
