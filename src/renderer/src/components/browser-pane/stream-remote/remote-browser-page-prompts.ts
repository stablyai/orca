import type {
  BrowserPagePromptRequest,
  BrowserPagePromptResult,
  BrowserStreamedPagePromptKind
} from '../../../../../shared/browser/prompts/browser-page-prompt'
import {
  RemoteBrowserJavaScriptDialog,
  type RemoteBrowserDialogPage,
  type RemoteBrowserJavaScriptDialogAsk
} from './remote-browser-javascript-dialog'
import type { RemoteBrowserRpcCall } from './remote-browser-page-session'
import type {
  BrowserFileChooserAnswerResult,
  BrowserFileChooserRequest
} from '../../../../../shared/browser/runtime/runtime-browser-contracts'

type StreamedPagePromptRequest = BrowserPagePromptRequest<BrowserStreamedPagePromptKind>

export type RemoteBrowserPagePromptDeps = {
  askJavaScriptDialog: RemoteBrowserJavaScriptDialogAsk
  /** Resolves the user's answer; null when they decline or dismiss it, or `signal` aborts. */
  askPagePrompt: (request: StreamedPagePromptRequest, signal: AbortSignal) => Promise<unknown>
  /** False when no app on this computer opened the link. */
  openExternalAppLink: (url: string) => Promise<boolean>
  reportPagePromptFailed: (request: StreamedPagePromptRequest) => void
  /** This computer's file picker; empty when the user closes it. */
  pickFiles: (multiple: boolean) => Promise<string[]>
  /** Copies the files to the page's host and returns its paths; empty when none arrived (reported here). */
  stageFilesOnHost: (page: RemoteBrowserDialogPage, paths: string[]) => Promise<string[]>
  /** The page's input was gone or the answer failed after the files uploaded. */
  reportFilesNotDelivered: (error: unknown) => void
  callRpc: RemoteBrowserRpcCall
}

/** Asks the streamed page's dialogs and its permission, sign-in and open-app prompts here, and answers them on the host. */
export class RemoteBrowserPagePrompts {
  readonly javaScriptDialog: RemoteBrowserJavaScriptDialog
  private readonly open = new Map<string, AbortController>()

  constructor(private readonly deps: RemoteBrowserPagePromptDeps) {
    this.javaScriptDialog = new RemoteBrowserJavaScriptDialog(deps)
  }

  show(request: StreamedPagePromptRequest, page: RemoteBrowserDialogPage): void {
    // The host replays open prompts to a reconnecting stream.
    if (this.open.has(request.requestId)) {
      return
    }
    const prompt = new AbortController()
    this.open.set(request.requestId, prompt)
    void this.deps.askPagePrompt(request, prompt.signal).then((answer) => {
      if (prompt.signal.aborted) {
        return
      }
      // Answered: the host's own close for it must not cancel the answer on its way.
      this.open.delete(request.requestId)
      void this.answerOnHost(page, request, answer).catch(() => {})
    })
  }

  /** This window's input opened the page's file picker: pick here, upload, then hand the files to the page. */
  chooseFiles(request: BrowserFileChooserRequest, page: RemoteBrowserDialogPage): void {
    const answer = (files: string[] | null) =>
      this.deps.callRpc<{ result: BrowserFileChooserAnswerResult }>(
        page.target,
        'browser.fileChooserAnswer',
        { requestId: request.requestId, files },
        { timeoutMs: 15_000, suppressFeatureInteraction: true }
      )
    void (async () => {
      const picked = await this.deps.pickFiles(request.multiple)
      const files = picked.length > 0 ? await this.deps.stageFilesOnHost(page, picked) : []
      const { result } = await answer(files.length > 0 ? files : null)
      if (files.length > 0 && result !== 'answered') {
        this.deps.reportFilesNotDelivered(null)
      }
    })().catch((error: unknown) => {
      // The page still waits on its picker: close it.
      void answer(null).catch(() => {})
      this.deps.reportFilesNotDelivered(error)
    })
  }

  /** The host closed it: answered by another viewer, timed out, or the page navigated. */
  close(requestId: string): void {
    this.open.get(requestId)?.abort()
    this.open.delete(requestId)
  }

  /** The stream ended: its host dismisses the dialog but keeps the prompts for the next stream until they time out. */
  closeAll(): void {
    this.javaScriptDialog.close()
    for (const prompt of this.open.values()) {
      prompt.abort()
    }
    this.open.clear()
  }

  private async answerOnHost(
    { target }: RemoteBrowserDialogPage,
    request: StreamedPagePromptRequest,
    answer: unknown
  ): Promise<void> {
    const { result } = await this.deps.callRpc<{ result: BrowserPagePromptResult }>(
      target,
      'browser.pagePromptAnswer',
      { requestId: request.requestId, answer },
      { timeoutMs: 15_000, suppressFeatureInteraction: true }
    )
    const url = request.kind === 'external-app' ? request.details.url : undefined
    if (result === 'answered' && answer && url && !(await this.deps.openExternalAppLink(url))) {
      this.deps.reportPagePromptFailed(request)
    }
  }
}
