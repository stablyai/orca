import type { BrowserExternalAppPrompt } from './browser-external-app'
import type { BrowserHttpAuthCredentials, BrowserHttpAuthPrompt } from './browser-http-auth'

/** Every prompt a page in the built-in browser can raise: what it shows, and a yes answer. */
export type BrowserPagePromptKinds = {
  'external-app': { details: BrowserExternalAppPrompt; answer: true }
  'http-auth': { details: BrowserHttpAuthPrompt; answer: BrowserHttpAuthCredentials }
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
  /** Null: the user declined. */
  answer: unknown
}

/** `failed`: the user said yes but Orca could not carry it out, e.g. no app opens the link. */
export type BrowserPagePromptResult = 'rejected' | 'answered' | 'failed'
