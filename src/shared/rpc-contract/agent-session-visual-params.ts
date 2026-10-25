import { z } from 'zod'
import { isNativeChatVisualFileName } from '../native-chat-visual-directive'
import { SessionId } from './structured-agent-session-identifiers'

// Read visuals on their owning host; accept bare filenames, never another host’s paths.

/** Content revision: hex digest of the file's bytes. */
const Revision = z.string().regex(/^[0-9a-f]{16,64}$/)

export const ReadVisualParams = z
  .object({
    sessionId: SessionId,
    file: z.string().refine(isNativeChatVisualFileName, 'Invalid visual file name'),
    // The revision the client already holds; a match answers `unchanged` without the bytes.
    knownRevision: Revision.optional()
  })
  .strict()

export type AgentSessionReadVisualParams = z.infer<typeof ReadVisualParams>

/** Positive host observations only; transport loss or an older host means unavailable/retryable, never these errors. */
export const AGENT_SESSION_VISUAL_READ_ERRORS = [
  'session_not_found',
  'unsupported_location',
  'not_found',
  'not_a_file',
  'outside_folder',
  'too_large',
  'not_text'
] as const

export type AgentSessionVisualReadError = (typeof AGENT_SESSION_VISUAL_READ_ERRORS)[number]

/** `path`: the visual's absolute path on the owning host. */
export type AgentSessionReadVisualResult =
  | { ok: true; revision: string; sizeBytes: number; path?: string; html: string }
  | { ok: true; revision: string; sizeBytes: number; path?: string; unchanged: true }
  | { ok: false; error: AgentSessionVisualReadError }
