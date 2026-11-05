import type { BrowserExternalAppPrompt } from './browser-external-app'
import type { BrowserHttpAuthCredentials, BrowserHttpAuthPrompt } from './browser-http-auth'
import type {
  BrowserJavaScriptDialogAnswer,
  BrowserJavaScriptDialogPrompt
} from './browser-javascript-dialog'
import type {
  BrowserSitePermissionDecision,
  BrowserSitePermissionPrompt
} from './browser-site-permission'

/** Every prompt a page in the built-in browser can raise: what it shows, and an answer. */
export type BrowserPagePromptKinds = {
  'external-app': { details: BrowserExternalAppPrompt; answer: true }
  'http-auth': { details: BrowserHttpAuthPrompt; answer: BrowserHttpAuthCredentials }
  'javascript-dialog': {
    details: BrowserJavaScriptDialogPrompt
    answer: BrowserJavaScriptDialogAnswer
  }
  'site-permission': { details: BrowserSitePermissionPrompt; answer: BrowserSitePermissionDecision }
}

export type BrowserPagePromptKind = keyof BrowserPagePromptKinds

export type BrowserPagePromptDetails<K extends BrowserPagePromptKind> =
  BrowserPagePromptKinds[K]['details']

export type BrowserPagePromptAnswer<K extends BrowserPagePromptKind> =
  BrowserPagePromptKinds[K]['answer']

export type BrowserPagePromptRequest<K extends BrowserPagePromptKind = BrowserPagePromptKind> = {
  [P in K]: { requestId: string; kind: P; details: BrowserPagePromptDetails<P> }
}[K]

export type BrowserPagePromptResponse = {
  requestId: string
  /** Null: the user declined or dismissed it. */
  answer: unknown
}

/** `failed`: the user said yes but Orca could not carry it out, e.g. no app opens the link. */
export type BrowserPagePromptResult = 'rejected' | 'answered' | 'failed'
