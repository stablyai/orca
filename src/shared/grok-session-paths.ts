import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

export const GROK_CHAT_HISTORY_FILE = 'chat_history.jsonl'
// Why: Grok URL-encodes the cwd for the sessions group directory. When that
// encoded name exceeds 255 bytes it switches to a slug+hash layout and stores
// the original path in a `.cwd` file — so callers must be able to find a
// session by id under the tree, not only via encodeURIComponent(cwd).
export const GROK_ENCODED_CWD_DIR_MAX_BYTES = 255

export type GrokSessionPathEnv =
  | NodeJS.ProcessEnv
  | Partial<Record<'GROK_HOME' | 'HOME' | 'USERPROFILE', string | undefined>>

/**
 * Resolve the Grok home directory. Official Grok Build uses `GROK_HOME` when
 * set, otherwise `~/.grok`.
 */
export function resolveGrokHomeDir(
  env: GrokSessionPathEnv = process.env,
  homeDir: string = homedir()
): string {
  const fromEnv = env.GROK_HOME?.trim()
  if (fromEnv) {
    return fromEnv
  }
  return join(homeDir, '.grok')
}

export function resolveGrokSessionsDir(
  env: GrokSessionPathEnv = process.env,
  homeDir: string = homedir()
): string {
  return join(resolveGrokHomeDir(env, homeDir), 'sessions')
}

/**
 * Directory name Grok uses for a cwd group when the encoded form is short
 * enough. When the encoded form would exceed 255 bytes, returns null so the
 * caller walks by session id instead of guessing the slug+hash layout.
 */
export function grokEncodedCwdDirName(cwd: string): string | null {
  const encoded = encodeURIComponent(cwd)
  if (Buffer.byteLength(encoded, 'utf8') > GROK_ENCODED_CWD_DIR_MAX_BYTES) {
    return null
  }
  return encoded
}

/**
 * Fast-path candidates for a chat_history.jsonl path when sessionId (+ optional
 * cwd) are known. Does not guarantee existence.
 */
export function buildGrokChatHistoryPathCandidates(args: {
  sessionId: string
  cwd?: string | null
  sessionsDir: string
}): string[] {
  const sessionId = args.sessionId.trim()
  if (!sessionId) {
    return []
  }
  const out: string[] = []
  const cwd = args.cwd?.trim()
  if (cwd) {
    const encoded = grokEncodedCwdDirName(cwd)
    if (encoded) {
      out.push(join(args.sessionsDir, encoded, sessionId, GROK_CHAT_HISTORY_FILE))
    }
  }
  return out
}

/**
 * Synchronous resolve used by the hook hot path. Tries cwd-based candidates
 * first, then walks the sessions tree for `<sessionId>/chat_history.jsonl`
 * (covers GROK_HOME, long-cwd slug groups, and missing cwd on the payload).
 */
export function resolveGrokChatHistoryPathSync(args: {
  sessionId: string
  cwd?: string | null
  sessionsDir?: string
  env?: GrokSessionPathEnv
  homeDir?: string
}): string | null {
  const sessionId = args.sessionId.trim()
  if (!sessionId) {
    return null
  }
  const sessionsDir =
    args.sessionsDir ?? resolveGrokSessionsDir(args.env ?? process.env, args.homeDir ?? homedir())

  for (const candidate of buildGrokChatHistoryPathCandidates({
    sessionId,
    cwd: args.cwd,
    sessionsDir
  })) {
    if (existsSync(candidate)) {
      return candidate
    }
  }

  return findGrokChatHistoryBySessionIdSync(sessionsDir, sessionId)
}

/**
 * Walk `sessionsDir` for `…/<sessionId>/chat_history.jsonl`. Bounded depth so
 * a pathological tree cannot hang the hook path.
 */
export function findGrokChatHistoryBySessionIdSync(
  sessionsDir: string,
  sessionId: string,
  maxDepth = 6
): string | null {
  if (!sessionId || !existsSync(sessionsDir)) {
    return null
  }
  return walkForChatHistory(sessionsDir, sessionId, 0, maxDepth)
}

function walkForChatHistory(
  dir: string,
  sessionId: string,
  depth: number,
  maxDepth: number
): string | null {
  if (depth > maxDepth) {
    return null
  }
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  // Prefer direct child named sessionId (common layout).
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name !== sessionId) {
      continue
    }
    const history = join(dir, entry.name, GROK_CHAT_HISTORY_FILE)
    if (existsSync(history)) {
      return history
    }
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }
    // Why: skip obvious non-group dirs without descending forever.
    if (entry.name === 'subagents' || entry.name.startsWith('.')) {
      continue
    }
    const found = walkForChatHistory(join(dir, entry.name), sessionId, depth + 1, maxDepth)
    if (found) {
      return found
    }
  }
  return null
}

/** True when path looks like a Grok chat_history under a session id directory. */
export function isGrokChatHistoryPath(path: string, sessionId: string): boolean {
  return basename(path) === GROK_CHAT_HISTORY_FILE && basename(dirname(path)) === sessionId.trim()
}

export function isDirectoryExisting(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
