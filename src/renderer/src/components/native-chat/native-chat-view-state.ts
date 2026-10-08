// Pure mapping from an assembled NativeChatSession to the discrete view state the
// UI renders. Keeping it a single function (not branching inside the .tsx) makes
// the empty/loading/error/working/ready dispatch testable and keeps the render
// tree to one switch.

import type { NativeChatSession } from '../../../../shared/native-chat-types'
import type { StructuredAgentSessionLaunchLifecycle } from '@/lib/structured-agent-session-launch'

/** The mutually-exclusive surfaces the chat view can show. `ready` and
 *  `working` both render the message list; `working` additionally shows the
 *  live in-flight indicator. The rest are full-pane states. */
export type NativeChatViewState =
  | { kind: 'loading' }
  | { kind: 'error'; message?: string }
  | { kind: 'empty' }
  | { kind: 'ready'; isWorking: false }
  | { kind: 'ready'; isWorking: true }

/**
 * Decide which surface to render. Any renderable message wins over loading/empty so optimistic
 * first sends never get replaced while transcript discovery catches up. Where the read retries on
 * its own (the structured chat), messages win over an error too: a read that fails after the
 * transcript loaded keeps it, and the error reaches the composer's error line. A read that does not
 * retry takes the pane: the terminal-backed one, whose only messages on error are local echoes, and
 * a structured read that failed for good.
 */
export function selectNativeChatViewState(
  session: NativeChatSession,
  { readRetries = false }: { readRetries?: boolean } = {}
): NativeChatViewState {
  // No text of its own: the empty state supplies the pane's translated line.
  const error: NativeChatViewState | null =
    session.status === 'error'
      ? { kind: 'error', ...(session.error ? { message: session.error } : {}) }
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

/**
 * A structured chat's history before its first read: `reading` while a read or a resuming launch
 * can still deliver it, `unread` when nothing will (a failed or unconfirmed resume, whose Retry line
 * says so), else `known`. A chat this pane started new has nothing to read; a cancelled launch reads
 * nothing either.
 */
export function structuredChatHistoryPhase(
  launch: {
    launch?: { kind: 'new' | 'resume' }
    lifecycle: StructuredAgentSessionLaunchLifecycle | null
    transportEnabled: boolean
  },
  readStatus: 'idle' | 'loading' | 'ready' | 'error'
): 'reading' | 'unread' | 'known' {
  if (launch.launch?.kind === 'new') {
    return 'known'
  }
  if (launch.transportEnabled) {
    return readStatus === 'ready' ? 'known' : 'reading'
  }
  if (launch.lifecycle === 'pending') {
    return 'reading'
  }
  return launch.lifecycle === 'failed' || launch.lifecycle === 'visibility-unknown'
    ? 'unread'
    : 'known'
}
