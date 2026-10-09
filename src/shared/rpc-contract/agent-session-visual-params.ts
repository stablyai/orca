import { z } from 'zod'
import { isNativeChatVisualFileName } from '../native-chat-visual-directive'
import { SessionId } from './structured-agent-session-identifiers'

// `agentSession.readVisual`: one HTML visual from a structured chat's visuals folder, read on the
// host that owns the chat. The client names only the session and a bare file name; the host
// resolves its own folder, so no client path ever reaches another host.

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

/**
 * Why a visual cannot be shown, as positively observed by the owning host. Transport loss and an
 * older host are never one of these: the client reads those as unavailable and may retry.
 */
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

export type AgentSessionReadVisualResult =
  | { ok: true; revision: string; sizeBytes: number; html: string }
  | { ok: true; revision: string; sizeBytes: number; unchanged: true }
  | { ok: false; error: AgentSessionVisualReadError }
