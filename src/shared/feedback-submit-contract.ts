/**
 * The `feedback:submit` IPC contract. Shared so the preload bridge's declared
 * shape cannot drift from what the main-process handler actually returns.
 */

export type FeedbackImageAttachment = {
  contentType: string
  data: Uint8Array
}

export type FeedbackSubmitArgs = {
  feedback: string
  submitAnonymously?: boolean
  githubLogin: string | null
  githubEmail: string | null
  images?: FeedbackImageAttachment[]
}

export type FeedbackRequestFailure = {
  status: number | null
  error: string
}

export type FeedbackSubmitResult =
  | {
      ok: true
      diagnosticBundleFailure?: FeedbackRequestFailure
      /** Absent when nothing was attached; false when the text landed but the images did not. */
      imagesDelivered?: boolean
      /** Set when the host rejected the images and the text was resent without them. */
      imagesFailure?: FeedbackRequestFailure
    }
  | ({ ok: false } & FeedbackRequestFailure & {
        diagnosticBundleFailure?: FeedbackRequestFailure
      })
