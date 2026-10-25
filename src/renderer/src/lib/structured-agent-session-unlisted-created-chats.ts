import type { ExecutionHostId } from '../../../shared/execution-host'

// Lists built before create can arrive after its reply; omission proves no close until a list actually shows the chat or protection expires.
const UNLISTED_CREATED_CHAT_TTL_MS = 30_000

type UnlistedCreatedChat = {
  executionHostId: ExecutionHostId
  timer: ReturnType<typeof setTimeout>
}

const unlistedCreatedChats = new Map<string, UnlistedCreatedChat>()

function chatKey(worktreeId: string, sessionId: string): string {
  return `${worktreeId}\u0000${sessionId}`
}

/** This client's create reply landed for a chat no host list has shown yet. */
export function recordUnlistedCreatedChat(
  worktreeId: string,
  sessionId: string,
  executionHostId: ExecutionHostId
): void {
  forgetUnlistedCreatedChat(worktreeId, sessionId)
  const key = chatKey(worktreeId, sessionId)
  const record: UnlistedCreatedChat = {
    executionHostId,
    timer: setTimeout(() => {
      if (unlistedCreatedChats.get(key) !== record) {
        return
      }
      unlistedCreatedChats.delete(key)
    }, UNLISTED_CREATED_CHAT_TTL_MS)
  }
  unlistedCreatedChats.set(key, record)
}

export function isUnlistedCreatedChat(worktreeId: string, sessionId: string): boolean {
  return unlistedCreatedChats.has(chatKey(worktreeId, sessionId))
}

/** `listedBy` limits the release to a list from the host the chat was created on. */
export function forgetUnlistedCreatedChat(
  worktreeId: string,
  sessionId: string,
  listedBy?: ExecutionHostId
): void {
  const key = chatKey(worktreeId, sessionId)
  const record = unlistedCreatedChats.get(key)
  if (!record || (listedBy !== undefined && record.executionHostId !== listedBy)) {
    return
  }
  clearTimeout(record.timer)
  unlistedCreatedChats.delete(key)
}
