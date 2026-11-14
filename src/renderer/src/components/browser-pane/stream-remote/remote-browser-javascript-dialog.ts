import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import type {
  BrowserJavaScriptDialog,
  BrowserJavaScriptDialogAnswer,
  BrowserJavaScriptDialogPrompt
} from '../../../../../shared/browser/prompts/browser-javascript-dialog'
import type { BrowserScreencastDialogResult } from '../../../../../shared/browser/runtime/runtime-browser-contracts'
import type { RemoteBrowserRpcCall } from './remote-browser-page-session'

export type RemoteBrowserJavaScriptDialogAsk = (
  dialog: BrowserJavaScriptDialogPrompt,
  signal: AbortSignal
) => Promise<BrowserJavaScriptDialogAnswer | null>

export type RemoteBrowserDialogPage = {
  target: RuntimeClientTarget
  worktree: string
  pageId: string
}

function toJavaScriptDialog(event: BrowserScreencastDialogResult): BrowserJavaScriptDialog | null {
  const type = event.dialogType
  // The host holds only these; asking about any other kind would offer an answer it refuses.
  if (type !== 'alert' && type !== 'confirm' && type !== 'prompt') {
    return null
  }
  return { type, message: event.message, defaultPromptText: '' }
}

/** Asks the person about the streamed page's open dialog and answers it on the host. */
export class RemoteBrowserJavaScriptDialog {
  private open: AbortController | null = null

  constructor(
    private readonly deps: {
      askJavaScriptDialog: RemoteBrowserJavaScriptDialogAsk
      callRpc: RemoteBrowserRpcCall
    }
  ) {}

  show(event: BrowserScreencastDialogResult, page: RemoteBrowserDialogPage): void {
    const dialog = toJavaScriptDialog(event)
    // The host repeats the dialog it still holds when a turned-away nested one closes.
    if (!dialog || this.open) {
      return
    }
    const open = new AbortController()
    this.open = open
    // The stream reports no frame origin, so the title can't name one.
    void this.deps.askJavaScriptDialog({ ...dialog, origin: null }, open.signal).then((answer) => {
      if (!open.signal.aborted) {
        void this.answerOnHost(page, answer, open.signal).catch(() => {})
      }
    })
  }

  /** The host closed it (answered here, by an agent or a phone, or by the page), or the stream ended. */
  close(): void {
    this.open?.abort()
    this.open = null
  }

  // A failed answer leaves the dialog to the host, which dismisses it when this stream stops.
  private answerOnHost(
    { target, worktree, pageId }: RemoteBrowserDialogPage,
    answer: BrowserJavaScriptDialogAnswer | null,
    // Closing it elsewhere first must not let this answer reach the page's next dialog.
    signal: AbortSignal
  ): Promise<unknown> {
    const params = { worktree, page: pageId }
    const options = { timeoutMs: 15_000, suppressFeatureInteraction: true, signal }
    return answer?.accept
      ? this.deps.callRpc(
          target,
          'browser.dialogAccept',
          { ...params, text: answer.promptText },
          options
        )
      : this.deps.callRpc(target, 'browser.dialogDismiss', params, options)
  }
}
