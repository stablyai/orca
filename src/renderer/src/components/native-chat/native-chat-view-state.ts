import type { NativeChatSession } from '../../../../shared/native-chat-types'
import type { StructuredAgentSessionLaunchLifecycle } from '@/lib/structured-agent-session-launch'

/** Ready renders the transcript; isWorking adds live activity. Other variants replace the pane. */
export type NativeChatViewState =
  | { kind: 'loading' }
  | { kind: 'error'; message?: string }
  | { kind: 'empty' }
  | { kind: 'ready'; isWorking: false }
  | { kind: 'ready'; isWorking: true }

/** Keep messages through loading and retryable errors; non-retrying errors replace the pane so local echoes cannot hide failure. */
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
  // Unflushed known sessions stay visually loading, retaining working status for Stop (#11032).
  if (session.status === 'working' && session.sessionId !== null) {
    return { kind: 'loading' }
  }
  // Before session discovery, transient working hooks must not replace the empty state with a spinner.
  return { kind: 'empty' }
}

/** Before the first read, resumes remain reading while launch/read can deliver history; failed/unconfirmed resumes are unread, new/cancelled chats known. */
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
