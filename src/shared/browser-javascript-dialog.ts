export const BROWSER_JAVASCRIPT_DIALOG_MESSAGE_MAX_CHARS = 16_384
export const BROWSER_JAVASCRIPT_DIALOG_PROMPT_MAX_CHARS = 4_096

export type BrowserJavaScriptDialogType = 'alert' | 'confirm' | 'prompt'

export type BrowserJavaScriptDialogOpenedEvent = {
  browserPageId: string
  dialogId: string
  dialogType: BrowserJavaScriptDialogType
  message: string
  defaultPromptText: string
  /** Sanitized origin only; frame URLs and query parameters never cross into renderer state. */
  origin: string
}

export type BrowserJavaScriptDialogClosedEvent = {
  browserPageId: string
  dialogId: string
}

export type BrowserJavaScriptDialogResponse = {
  browserPageId: string
  dialogId: string
  accept: boolean
  promptText?: string
}
