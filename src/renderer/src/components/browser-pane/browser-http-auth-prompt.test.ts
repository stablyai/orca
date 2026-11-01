import { describe, expect, it, vi } from 'vitest'
import type {
  ConfirmationDialogContextValue,
  ConfirmationDialogOptions
} from '@/components/confirmation-dialog-context'

import { httpAuthPrompt } from './browser-http-auth-prompt'

const signal = new AbortController().signal

describe('browser HTTP auth prompt', () => {
  it('names the site, warns on plain http, and answers with what the user typed', async () => {
    // Stands in for the user typing into the dialog's fields and pressing Sign in.
    const confirm = vi.fn(async (options: ConfirmationDialogOptions) => {
      options.fields?.onConfirmed({ username: 'qa', password: 'hunter2' })
      return true
    })

    await expect(
      httpAuthPrompt.ask(confirm, { origin: 'http://192.168.1.20:8080', retry: true }, signal)
    ).resolves.toEqual({ username: 'qa', password: 'hunter2' })
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Sign in',
        description: [
          'http://192.168.1.20:8080 is asking for a username and password.',
          "Your connection to this site isn't private.",
          "That username or password didn't work."
        ].join('\n')
      })
    )
  })

  it('declines when the user cancels', async () => {
    const confirm = vi.fn<ConfirmationDialogContextValue>().mockResolvedValue(false)

    await expect(
      httpAuthPrompt.ask(confirm, { origin: 'https://staging.acme.com', retry: false }, signal)
    ).resolves.toBeNull()
    expect(confirm.mock.calls[0][0].description).toBe(
      'https://staging.acme.com is asking for a username and password.'
    )
  })
})
