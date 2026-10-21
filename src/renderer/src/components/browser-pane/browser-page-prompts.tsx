import { useEffect } from 'react'
import type {
  BrowserPagePromptAnswer,
  BrowserPagePromptDetails,
  BrowserPagePromptKind,
  BrowserPagePromptRequest
} from '../../../../shared/browser-page-prompt'
import {
  useConfirmationDialog,
  type ConfirmationDialogContextValue
} from '@/components/confirmation-dialog-context'
import { externalAppPrompt } from './browser-external-app-prompt'
import { httpAuthPrompt } from './browser-http-auth-prompt'

/** How the window asks one kind of page prompt. */
export type BrowserPagePromptHandler<K extends BrowserPagePromptKind> = {
  /** Resolves the user's yes answer; null when they decline or `signal` aborts. */
  ask: (
    confirm: ConfirmationDialogContextValue,
    details: BrowserPagePromptDetails<K>,
    signal: AbortSignal
  ) => Promise<BrowserPagePromptAnswer<K> | null>
  /** The user said yes but Orca could not carry it out. */
  onFailed?: (details: BrowserPagePromptDetails<K>) => void
}

const PROMPT_HANDLERS: { [K in BrowserPagePromptKind]: BrowserPagePromptHandler<K> } = {
  'external-app': externalAppPrompt,
  'http-auth': httpAuthPrompt
}

async function answerPrompt<K extends BrowserPagePromptKind>(
  confirm: ConfirmationDialogContextValue,
  request: BrowserPagePromptRequest<K>,
  signal: AbortSignal
): Promise<void> {
  const handler: BrowserPagePromptHandler<K> = PROMPT_HANDLERS[request.kind]
  const answer = await handler.ask(confirm, request.details, signal)
  if (signal.aborted) {
    return
  }
  const result = await window.api.browser.respondPagePrompt({
    requestId: request.requestId,
    answer
  })
  if (result === 'failed') {
    handler.onFailed?.(request.details)
  }
}

export function subscribeBrowserPagePrompts(confirm: ConfirmationDialogContextValue): () => void {
  if (typeof window.api.browser?.onPagePromptRequest !== 'function') {
    return () => {}
  }
  const prompts = new Map<string, AbortController>()
  const unsubscribeClosed = window.api.browser.onPagePromptClosed(({ requestId }) =>
    prompts.get(requestId)?.abort()
  )
  const unsubscribeRequests = window.api.browser.onPagePromptRequest((request) => {
    const prompt = new AbortController()
    prompts.set(request.requestId, prompt)
    void answerPrompt(confirm, request, prompt.signal).finally(() =>
      prompts.delete(request.requestId)
    )
  })
  return () => {
    unsubscribeRequests()
    unsubscribeClosed()
  }
}

export function BrowserPagePrompts(): null {
  const confirm = useConfirmationDialog()
  useEffect(() => subscribeBrowserPagePrompts(confirm), [confirm])
  return null
}
