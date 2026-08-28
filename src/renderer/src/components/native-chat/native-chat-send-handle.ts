/** Cancels an in-flight send's pending pty writes (the delayed Enter, and any
 *  later question bodies/Enters). Safe to call after the send completes. */
export type NativeChatSendHandle = {
  cancel: () => void
  cancelled?: () => boolean
  /** Time after which every scheduled write has fired and the handle can drop. */
  settleAfterMs: number
  /** Actual completion, which can outlive the nominal schedule if the renderer stalls. */
  settled?: Promise<void>
}
