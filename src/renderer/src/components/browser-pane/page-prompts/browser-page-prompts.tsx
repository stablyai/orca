import { useEffect } from 'react'
import type {
  BrowserPagePromptAnswer,
  BrowserPagePromptDetails,
  BrowserPagePromptKind,
  BrowserPagePromptRequest
} from '../../../../../shared/browser/prompts/browser-page-prompt'
import {
  useConfirmationDialog,
  type ConfirmationDialogContextValue
} from '@/components/dismiss/confirmation/confirmation-dialog-context'

/** How the window asks one kind of page prompt. */
export type BrowserPagePromptHandler<K extends BrowserPagePromptKind> = {
  /** Resolves the user's answer; null when they decline or dismiss it, or `signal` aborts. */
  ask: (
    confirm: ConfirmationDialogContextValue,
    details: BrowserPagePromptDetails<K>,
    signal: AbortSignal
  ) => Promise<BrowserPagePromptAnswer<K> | null>
  /** The user said yes but Orca could not carry it out. */
  onFailed?: (details: BrowserPagePromptDetails<K>) => void
}

type BrowserPagePromptHandlers = {
  [K in BrowserPagePromptKind]: BrowserPagePromptHandler<K>
}

let promptHandlersPromise: Promise<BrowserPagePromptHandlers> | null = null

function loadBrowserPagePromptHandlers(): Promise<BrowserPagePromptHandlers> {
  if (!promptHandlersPromise) {
    promptHandlersPromise = import('./browser-page-prompt-handlers')
      .then((module) => module.BROWSER_PAGE_PROMPT_HANDLERS)
      .catch((error: unknown) => {
        promptHandlersPromise = null
        throw error
      })
  }
  return promptHandlersPromise
}

/** Asks a page prompt the way this window does; streamed server pages ask through it too. */
export async function askBrowserPagePrompt<K extends BrowserPagePromptKind>(
  confirm: ConfirmationDialogContextValue,
  request: BrowserPagePromptRequest<K>,
  signal: AbortSignal
): Promise<BrowserPagePromptAnswer<K> | null> {
  const handlers = await loadBrowserPagePromptHandlers()
  if (signal.aborted) {
    return null
  }
  const handler: BrowserPagePromptHandler<K> = handlers[request.kind]
  return handler.ask(confirm, request.details, signal)
}

export function reportBrowserPagePromptFailed<K extends BrowserPagePromptKind>(
  request: BrowserPagePromptRequest<K>
): void {
  void loadBrowserPagePromptHandlers()
    .then((handlers) => {
      const handler: BrowserPagePromptHandler<K> = handlers[request.kind]
      handler.onFailed?.(request.details)
    })
    .catch(() => {})
}

async function answerPrompt<K extends BrowserPagePromptKind>(
  confirm: ConfirmationDialogContextValue,
  request: BrowserPagePromptRequest<K>,
  signal: AbortSignal
): Promise<void> {
  const answer = await askBrowserPagePrompt(confirm, request, signal)
  if (signal.aborted) {
    return
  }
  const result = await window.api.browser.respondPagePrompt({
    requestId: request.requestId,
    answer
  })
  if (result === 'failed') {
    reportBrowserPagePromptFailed(request)
  }
}

function subscribeBrowserPagePrompts(confirm: ConfirmationDialogContextValue): () => void {
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
