import { describe, expect, it, vi } from 'vitest'
import type { ConfirmationDialogContextValue } from '@/components/confirmation-dialog-context'

import { localNetworkPrompt } from './browser-local-network-prompt'

const signal = new AbortController().signal

describe('browser local-network prompt', () => {
  it('names the asking origin and answers yes with Allow', async () => {
    const confirm = vi.fn<ConfirmationDialogContextValue>().mockResolvedValue(true)

    await expect(
      localNetworkPrompt.ask(confirm, { origin: 'https://acme.okta.com' }, signal)
    ).resolves.toBe(true)
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Apps and services on this device / local network',
        description: expect.stringContaining('https://acme.okta.com'),
        confirmLabel: 'Allow',
        cancelLabel: 'Deny'
      })
    )
  })

  it('declines on Deny', async () => {
    const confirm = vi.fn<ConfirmationDialogContextValue>().mockResolvedValue(false)

    await expect(
      localNetworkPrompt.ask(confirm, { origin: 'https://acme.okta.com' }, signal)
    ).resolves.toBeNull()
  })
})
