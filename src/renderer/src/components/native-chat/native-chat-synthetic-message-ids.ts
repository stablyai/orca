// Ids the renderer mints for bubbles that are not authoritative transcript turns:
// optimistic composer echoes, the seeded launch prompt, and slash-command markers.
// The prefixes live here rather than in the modules that build them because the
// list's sort has to classify a message from its id alone, and importing the whole
// pending-send module (caches included) just to test a prefix inverted the
// dependency between the assembler and the composer state it is meant to order.

const PENDING_ID_PREFIX = 'pending:'
// A send issued while the agent was already replying. Split from the plain prefix
// so the sort can put the streaming reply above a queued prompt but below the
// prompt it is actually answering.
const QUEUED_PENDING_ID_PREFIX = 'pending-queued:'
const LAUNCH_PROMPT_ID_PREFIX = 'launch-pending:'
const COMMAND_MARKER_ID_PREFIX = 'command:'

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

export function nativeChatCommandMarkerMessageId(markerId: string): string {
  return `${COMMAND_MARKER_ID_PREFIX}${markerId}`
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

/** True when a message id was minted for a slash-command marker. */
export function isCommandMarkerId(id: string): boolean {
  return id.startsWith(COMMAND_MARKER_ID_PREFIX)
}
