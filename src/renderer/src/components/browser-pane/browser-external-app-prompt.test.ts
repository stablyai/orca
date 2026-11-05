import { describe, expect, it, vi } from 'vitest'
import type { ConfirmationDialogContextValue } from '@/components/confirmation-dialog-context'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

import { externalAppPrompt } from './browser-external-app-prompt'

const signal = new AbortController().signal

describe('browser external-app prompt', () => {
  it('names the app and the asking site, and answers yes with Open', async () => {
    const confirm = vi.fn<ConfirmationDialogContextValue>().mockResolvedValue(true)

    await expect(
      externalAppPrompt.ask(
        confirm,
        {
          appName: 'Okta Verify',
          scheme: 'com-okta-authenticator',
          origin: 'https://acme.okta.com'
        },
        signal
      )
    ).resolves.toBe(true)
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Open Okta Verify?',
        description: 'https://acme.okta.com wants to open another application.',
        confirmLabel: 'Open Okta Verify'
      })
    )
  })

  it('falls back to the link type when the app is unknown, and declines on Cancel', async () => {
    const confirm = vi.fn<ConfirmationDialogContextValue>().mockResolvedValue(false)

    await expect(
      externalAppPrompt.ask(confirm, { appName: null, scheme: 'zoommtg', origin: null }, signal)
    ).resolves.toBeNull()
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Open this zoommtg link?',
        description: 'A page in the browser wants to open another application.',
        confirmLabel: 'Open link'
      })
    )
  })
})
