import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserExternalAppRequest } from '../../../../shared/browser-external-app'
import type { ConfirmationDialogContextValue } from '@/components/confirmation-dialog-context'

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: toastError } }))

import { subscribeBrowserExternalAppConfirmation } from './browser-external-app-confirmation'

const respondExternalApp = vi.fn()

function installSubscription(confirm: ConfirmationDialogContextValue): {
  emit: (request: BrowserExternalAppRequest) => void
  close: (requestId: string) => void
} {
  let listener: ((request: BrowserExternalAppRequest) => void) | null = null
  let closedListener: ((event: { requestId: string }) => void) | null = null
  vi.stubGlobal('window', {
    api: {
      browser: {
        onExternalAppRequest: (callback: (request: BrowserExternalAppRequest) => void) => {
          listener = callback
          return () => {}
        },
        onExternalAppRequestClosed: (callback: (event: { requestId: string }) => void) => {
          closedListener = callback
          return () => {}
        },
        respondExternalApp
      }
    }
  })
  subscribeBrowserExternalAppConfirmation(confirm)
  if (!listener || !closedListener) {
    throw new Error('external-app confirmation did not subscribe')
  }
  return {
    emit: (request) => listener?.(request),
    close: (requestId) => closedListener?.({ requestId })
  }
}

beforeEach(() => {
  respondExternalApp.mockReset()
  respondExternalApp.mockResolvedValue('answered')
  toastError.mockReset()
})

describe('browser external-app confirmation', () => {
  it('names the app and the asking site, and reports the answer', async () => {
    const confirm = vi.fn<ConfirmationDialogContextValue>().mockResolvedValue(true)
    const { emit } = installSubscription(confirm)

    emit({
      requestId: 'r1',
      appName: 'Okta Verify',
      scheme: 'com-okta-authenticator',
      origin: 'https://acme.okta.com'
    })

    await vi.waitFor(() =>
      expect(respondExternalApp).toHaveBeenCalledWith({ requestId: 'r1', open: true })
    )
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Open Okta Verify?',
        description: 'https://acme.okta.com wants to open another application.',
        confirmLabel: 'Open Okta Verify'
      })
    )
  })

  it('falls back to the link type when the app is unknown, and reports a cancel', async () => {
    const confirm = vi.fn<ConfirmationDialogContextValue>().mockResolvedValue(false)
    const { emit } = installSubscription(confirm)

    emit({ requestId: 'r2', appName: null, scheme: 'zoommtg', origin: null })

    await vi.waitFor(() =>
      expect(respondExternalApp).toHaveBeenCalledWith({ requestId: 'r2', open: false })
    )
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Open this zoommtg link?',
        description: 'A page in the browser wants to open another application.',
        confirmLabel: 'Open link'
      })
    )
  })

  it('says so when the user chose Open but no app could be started', async () => {
    const { emit } = installSubscription(
      vi.fn<ConfirmationDialogContextValue>().mockResolvedValue(true)
    )
    respondExternalApp.mockResolvedValue('launch-failed')

    emit({ requestId: 'r4', appName: null, scheme: 'zoommtg', origin: null })

    await vi.waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "Couldn't open an app for this zoommtg link. It may not be installed."
      )
    )
  })

  it('dismisses the prompt when main closes the request', () => {
    const confirm = vi.fn<ConfirmationDialogContextValue>(() => new Promise(() => {}))
    const { emit, close } = installSubscription(confirm)

    emit({ requestId: 'r3', appName: 'Slack', scheme: 'slack', origin: 'https://slack.com' })
    close('r3')

    expect(confirm.mock.calls[0][0].signal?.aborted).toBe(true)
  })
})
