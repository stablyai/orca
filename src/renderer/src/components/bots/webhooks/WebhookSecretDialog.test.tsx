// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebhookAdapterId } from '../../../../../shared/connector-webhook-contract'
import { WebhookSecretDialog } from './WebhookSecretDialog'
import { setWebhookHostTransportForTests } from './webhook-host-client'
import { webhookSummaryFixture } from './webhook-summary.test-fixture'

const host = vi.fn()

function renderDialog(adapter: WebhookAdapterId | null): void {
  host.mockReset().mockResolvedValue({})
  setWebhookHostTransportForTests(host)
  render(
    <WebhookSecretDialog
      target={{ kind: 'local' }}
      summary={webhookSummaryFixture({ adapter })}
      botName="Scout"
      open
      onOpenChange={() => {}}
    />
  )
}

function secretParams(): unknown {
  return host.mock.calls.find(([, method]) => method === 'webhooks.secret')?.[2]
}

afterEach(() => {
  cleanup()
  setWebhookHostTransportForTests(null)
})

describe('WebhookSecretDialog secret source', () => {
  it('lets Standard Webhooks generate by default, as before', async () => {
    renderDialog(null)
    expect(screen.getByRole('radio', { name: 'Orca makes one' }).getAttribute('aria-checked')).toBe(
      'true'
    )
    expect(screen.queryByLabelText('Standard Webhooks secret')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Generate secret' }))
    await waitFor(() => expect(secretParams()).toMatchObject({ generate: true }))
    expect(secretParams()).not.toHaveProperty('secret')
  })

  it('saves a pasted Standard Webhooks secret as typed, trimmed', async () => {
    renderDialog('standard')
    fireEvent.click(screen.getByRole('radio', { name: 'Paste the sender’s' }))
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save.hasAttribute('disabled')).toBe(true)
    fireEvent.change(screen.getByLabelText('Standard Webhooks secret'), {
      target: { value: '  pasted-test-value  ' }
    })
    fireEvent.click(save)
    await waitFor(() =>
      expect(secretParams()).toMatchObject({ adapter: 'standard', secret: 'pasted-test-value' })
    )
    expect(secretParams()).not.toHaveProperty('generate')
  })

  it('keeps GitHub generate-only and the other senders paste-only', () => {
    renderDialog('github')
    expect(screen.queryByRole('radiogroup')).toBeNull()
    expect(screen.getByRole('button', { name: 'Generate secret' })).toBeTruthy()
    cleanup()
    renderDialog('sentry')
    expect(screen.queryByRole('radiogroup')).toBeNull()
    expect(screen.getByLabelText('Sentry secret')).toBeTruthy()
  })
})
