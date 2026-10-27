import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserPagePromptRequest } from '../../../../shared/browser-page-prompt'
import type {
  ConfirmationDialogContextValue,
  ConfirmationDialogOptions
} from '@/components/confirmation-dialog-context'

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: toastError } }))

import { subscribeBrowserPagePrompts } from './browser-page-prompts'

const respondPagePrompt = vi.fn()

function installSubscription(confirm: ConfirmationDialogContextValue): {
  emit: (request: BrowserPagePromptRequest) => void
  close: (requestId: string) => void
} {
  let listener: ((request: BrowserPagePromptRequest) => void) | null = null
  let closedListener: ((event: { requestId: string }) => void) | null = null
  vi.stubGlobal('window', {
    api: {
      browser: {
        onPagePromptRequest: (callback: (request: BrowserPagePromptRequest) => void) => {
          listener = callback
          return () => {}
        },
        onPagePromptClosed: (callback: (event: { requestId: string }) => void) => {
          closedListener = callback
          return () => {}
        },
        respondPagePrompt
      }
    }
  })
  subscribeBrowserPagePrompts(confirm)
  if (!listener || !closedListener) {
    throw new Error('page prompts did not subscribe')
  }
  return {
    emit: (request) => listener?.(request),
    close: (requestId) => closedListener?.({ requestId })
  }
}

beforeEach(() => {
  respondPagePrompt.mockReset()
  respondPagePrompt.mockResolvedValue('answered')
  toastError.mockReset()
})

describe('browser page prompts', () => {
  it("asks with the prompt's own kind and sends back its answer", async () => {
    // Stands in for the user typing into the dialog's fields and pressing Sign in.
    const confirm = vi.fn(async (options: ConfirmationDialogOptions) => {
      options.fields?.onConfirmed({ username: 'qa', password: 'hunter2' })
      return true
    })
    const { emit } = installSubscription(confirm)

    emit({
      requestId: 'r1',
      kind: 'http-auth',
      details: { origin: 'https://staging.acme.com', retry: false }
    })

    await vi.waitFor(() =>
      expect(respondPagePrompt).toHaveBeenCalledWith({
        requestId: 'r1',
        answer: { username: 'qa', password: 'hunter2' }
      })
    )
  })

  it('dismisses the prompt without answering when main closes the request', async () => {
    const confirm = vi.fn<ConfirmationDialogContextValue>(
      (options) =>
        new Promise((resolve) => options.signal?.addEventListener('abort', () => resolve(false)))
    )
    const { emit, close } = installSubscription(confirm)

    emit({
      requestId: 'r2',
      kind: 'external-app',
      details: { appName: 'Slack', scheme: 'slack', origin: 'https://slack.com' }
    })
    close('r2')

    await Promise.resolve()
    expect(confirm.mock.calls[0][0].signal?.aborted).toBe(true)
    expect(respondPagePrompt).not.toHaveBeenCalled()
  })

  it("says so when the user said yes but Orca couldn't carry it out", async () => {
    respondPagePrompt.mockResolvedValue('failed')
    const { emit } = installSubscription(
      vi.fn<ConfirmationDialogContextValue>().mockResolvedValue(true)
    )

    emit({
      requestId: 'r3',
      kind: 'external-app',
      details: { appName: null, scheme: 'zoommtg', origin: null }
    })

    await vi.waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "Couldn't open an app for this zoommtg link. It may not be installed."
      )
    )
  })
})
