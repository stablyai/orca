import { open } from 'node:fs/promises'
import { isSafeJcodeSessionId, jcodeSessionFilePath } from './jcode-session-files'

// Session serializes `id` then `parent_id` first (jcode-base session.rs), so a small prefix holds it.
const PARENT_PREFIX_BYTES = 4096
const PARENT_ID_RE = /"parent_id"\s*:\s*(null|"[^"]*")/
const MAX_CACHED_SESSIONS = 512

// A session's parent never changes, so each verdict is read once per session file.
const helperBySessionFile = new Map<string, boolean>()
const pendingReads = new Map<string, Promise<void>>()

/** Settles once the session's helper verdict is cached; a missing or unsaved file stays unknown. */
export function prefetchJcodeHelperSession(sessionId: unknown): Promise<void> | undefined {
  if (!isSafeJcodeSessionId(sessionId)) {
    return undefined
  }
  const path = jcodeSessionFilePath(sessionId.trim())
  if (helperBySessionFile.has(path)) {
    return undefined
  }
  const pending = pendingReads.get(path) ?? readParentVerdict(path)
  pendingReads.set(path, pending)
  return pending
}

async function readParentVerdict(path: string): Promise<void> {
  try {
    const file = await open(path, 'r')
    try {
      const buffer = Buffer.alloc(PARENT_PREFIX_BYTES)
      const { bytesRead } = await file.read(buffer, 0, PARENT_PREFIX_BYTES, 0)
      const parent = PARENT_ID_RE.exec(buffer.toString('utf8', 0, bytesRead))?.[1]
      if (parent !== undefined) {
        const oldest = helperBySessionFile.keys().next().value
        if (helperBySessionFile.size >= MAX_CACHED_SESSIONS && oldest !== undefined) {
          helperBySessionFile.delete(oldest)
        }
        helperBySessionFile.set(path, parent !== 'null')
      }
    } finally {
      await file.close()
    }
  } catch {
    // Unknown sessions are never fenced; the next hook reads again.
  } finally {
    pendingReads.delete(path)
  }
}

/** Swarm helpers run in sessions whose file names a parent; the pane's own session has none.
 *  Visible spawns open their own parentless session, so they are never treated as helpers. */
export function isCachedJcodeHelperSession(sessionId: string | undefined): boolean {
  return (
    isSafeJcodeSessionId(sessionId) &&
    helperBySessionFile.get(jcodeSessionFilePath(sessionId.trim())) === true
  )
}
