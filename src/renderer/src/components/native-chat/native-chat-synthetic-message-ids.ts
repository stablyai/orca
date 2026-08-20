// Ids the renderer mints for bubbles that are not authoritative transcript turns:
// optimistic composer echoes and the seeded launch prompt. They live here rather
// than in native-chat-pending because the list's sort classifies a message from its
// id alone, and importing that module's caches just to test a prefix inverted the
// dependency between the assembler and the composer state it orders.
// Slash-command ids stay in native-chat-command-marker, which nothing here sorts.

const PENDING_ID_PREFIX = 'pending:'
// A send issued while the agent was already replying. Split from the plain prefix
// so the sort can put the streaming reply above a queued prompt but below the
// prompt it is actually answering.
const QUEUED_PENDING_ID_PREFIX = 'pending-queued:'
const LAUNCH_PROMPT_ID_PREFIX = 'launch-pending:'

/** Mint the id for an optimistic echo, tiering it by when the send was issued. */
export function nativeChatPendingMessageId(
  pendingId: string,
  queuedWhileWorking?: boolean
): string {
  return `${queuedWhileWorking ? QUEUED_PENDING_ID_PREFIX : PENDING_ID_PREFIX}${pendingId}`
}

export function nativeChatLaunchPromptMessageId(tabId: string): string {
  return `${LAUNCH_PROMPT_ID_PREFIX}${tabId}`
}

/** True when a message id was minted for an optimistic pending send. */
export function isPendingMessageId(id: string): boolean {
  return id.startsWith(PENDING_ID_PREFIX) || id.startsWith(QUEUED_PENDING_ID_PREFIX)
}

/** True for an echo the user queued while the agent was already replying, so it
 *  belongs after the in-flight reply rather than above it. */
export function isQueuedPendingMessageId(id: string): boolean {
  return id.startsWith(QUEUED_PENDING_ID_PREFIX)
}

export function isLaunchPromptMessageId(id: string): boolean {
  return id.startsWith(LAUNCH_PROMPT_ID_PREFIX)
}
