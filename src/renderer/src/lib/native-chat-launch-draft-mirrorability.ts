/**
 * Single source of truth for whether unsent launch context can be mirrored from
 * the agent's TUI input into the native-chat composer.
 *
 * Both the seeding path (`seedNativeChatLaunchDraftForAgentTab`) and the
 * initial-view-mode decision (`decideInitialAgentTabViewMode`) gate on this one
 * predicate, so a draft launch can never open in chat with a composer that
 * chat then refuses to fill.
 *
 * Multi-line is rejected because the chat send pre-clears the TUI input with
 * Ctrl+U (\x15) — kill-to-start-of-LINE, not of the whole buffer — so earlier
 * lines of a multi-line mirror would survive and concatenate onto the message
 * being sent. Relaxing that rule belongs here and nowhere else: teaching this
 * predicate to accept multi-line flips seeding and view mode together.
 */
export function canMirrorLaunchDraftToNativeChat(text: string): boolean {
  return text.trim().length > 0 && !/[\r\n\u2028\u2029]/.test(text)
}
