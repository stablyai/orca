// Pure mapping from an assembled NativeChatSession to the discrete view state the
// UI renders. Keeping it a single function (not branching inside the .tsx) makes
// the empty/loading/error/working/ready dispatch testable and keeps the render
// tree to one switch.

import type { NativeChatSession } from '../../../../shared/native-chat-types'

/** The mutually-exclusive surfaces the chat view can show. `ready` and
 *  `working` both render the message list; `working` additionally shows the
 *  live in-flight indicator. The rest are full-pane states. */
export type NativeChatViewState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'empty' }
  | { kind: 'ready'; isWorking: false }
  | { kind: 'ready'; isWorking: true }

/**
 * Decide which surface to render. Any renderable message wins over loading/empty so optimistic
 * first sends never get replaced while transcript discovery catches up. Where the read retries on
 * its own (the structured chat), messages win over an error too: a read that fails after the
 * transcript loaded keeps it, and the error reaches the composer's error line. The terminal-backed
 * read does not retry, and its only messages on error are local echoes, so its error takes the pane.
 */
export function selectNativeChatViewState(
  session: NativeChatSession,
  { readRetries = false }: { readRetries?: boolean } = {}
): NativeChatViewState {
  const error: NativeChatViewState | null =
    session.status === 'error'
      ? { kind: 'error', message: session.error ?? 'Conversation could not be loaded.' }
      : null
  if (error && !readRetries) {
    return error
  }
  if (session.messages.length > 0) {
    return { kind: 'ready', isWorking: session.status === 'working' }
  }
  if (error) {
    return error
  }
  if (session.status === 'loading') {
    return { kind: 'loading' }
  }
  // A KNOWN session working with nothing to show is a transcript that has not
  // flushed yet, so hold the loading surface rather than flashing empty (#11032).
  // The status stays 'working', so the composer keeps Stop the moment a bubble
  // lands — forcing 'loading' upstream instead rendered an idle pane mid-turn.
  if (session.status === 'working' && session.sessionId !== null) {
    return { kind: 'loading' }
  }
  // Empty wins over a transient 'working' hook so a just-toggled, pre-session
  // pane shows a clear empty state instead of a spinner over nothing.
  return { kind: 'empty' }
}
