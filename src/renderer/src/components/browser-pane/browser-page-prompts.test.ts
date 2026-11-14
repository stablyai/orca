import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserPagePromptRequest } from '../../../../shared/browser/prompts/browser-page-prompt'
import type { ConfirmationDialogContextValue } from '@/components/confirmation-dialog-context'

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
})
