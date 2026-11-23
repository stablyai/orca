import type { ConfirmationDialogContextValue } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { javaScriptDialogPrompt } from '../page-prompts/browser-javascript-dialog-prompt'
import {
  askBrowserPagePrompt,
  reportBrowserPagePromptFailed
} from '../page-prompts/browser-page-prompts'
import type { RemoteBrowserPagePromptDeps } from './remote-browser-page-prompts'

/** A streamed page's prompts ask with this window's own dialogs. */
export function remoteBrowserPagePromptAsks(
  confirm: ConfirmationDialogContextValue
): Omit<RemoteBrowserPagePromptDeps, 'callRpc'> {
  return {
    askJavaScriptDialog: (dialog, signal) => javaScriptDialogPrompt.ask(confirm, dialog, signal),
    askPagePrompt: (request, signal) => askBrowserPagePrompt(confirm, request, signal),
    // Web clients have no app launcher here.
    openExternalAppLink: (url) =>
      window.api.browser?.openStreamedExternalAppLink?.(url) ?? Promise.resolve(false),
    reportPagePromptFailed: reportBrowserPagePromptFailed
  }
}
