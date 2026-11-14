/** A page's open `alert()`, `confirm()` or `prompt()` in the built-in browser. */
export type BrowserJavaScriptDialog = {
  type: 'alert' | 'confirm' | 'prompt'
  message: string
  /** The text a prompt starts with; empty for alert and confirm. */
  defaultPromptText: string
}

export type BrowserJavaScriptDialogPrompt = BrowserJavaScriptDialog & {
  /** Origin of the page that opened it; null when it has none, e.g. `about:blank`. */
  origin: string | null
}

export type BrowserJavaScriptDialogAnswer = {
  accept: boolean
  /** What a prompt returns when accepted. */
  promptText: string
}
