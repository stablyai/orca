export type NativeChatCliForkOrigin = {
  sessionId: string
  workspaceId: string
}

// Session-only, keyed by the fork's own conversation: until its first message the fork has no
// transcript, so the chat it was forked from is still that conversation.
const forkOrigins = new Map<string, NativeChatCliForkOrigin>()
const MAX_FORK_ORIGINS = 100

const forkOriginKey = (workspaceId: string, providerSessionId: string): string =>
  `${workspaceId}\0${providerSessionId}`

export function rememberBoundedNativeChatCliForkOrigin(
  workspaceId: string,
  providerSessionId: string,
  origin: NativeChatCliForkOrigin
): void {
  const key = forkOriginKey(workspaceId, providerSessionId)
  forkOrigins.delete(key)
  forkOrigins.set(key, origin)
  if (forkOrigins.size > MAX_FORK_ORIGINS) {
    const oldest = forkOrigins.keys().next().value
    if (oldest !== undefined) {
      forkOrigins.delete(oldest)
    }
  }
}

export function takeNativeChatCliForkOrigin(
  workspaceId: string,
  providerSessionId: string
): NativeChatCliForkOrigin | undefined {
  const key = forkOriginKey(workspaceId, providerSessionId)
  const origin = forkOrigins.get(key)
  if (origin) {
    forkOrigins.delete(key)
  }
  return origin
}

/** Drop remembered CLI fork origins belonging to a removed workspace. */
export function forgetNativeChatCliForkOriginsForWorktree(workspaceId: string): void {
  for (const [key, origin] of forkOrigins) {
    if (origin.workspaceId === workspaceId) {
      forkOrigins.delete(key)
    }
  }
}
