/**
 * Host-owned terminal draft editing. A client edits locally, then asks the execution host to
 * replace the agent's real editor buffer. "Saved" (bytes in the editor) and "submitted" (a turn
 * started) stay separate facts; neither is inferred from a screen scrape.
 */

export const TERMINAL_DRAFT_PROTOCOL_VERSION = 1

export type TerminalDraftClient = {
  id: string
  type: 'desktop' | 'mobile'
}

export type TerminalDraftUnavailableReason =
  | 'no_bridge'
  | 'stale_bridge'
  | 'unsupported_agent'
  | 'not_live'
  | 'bridge_timeout'
  | 'invalid_bridge_reply'

export type TerminalDraftCapability = {
  supported: boolean
  adapter?: 'pi-editor'
  /** Host-derived identity of the agent process that owns the editor. */
  processIncarnation?: string
  reason?: TerminalDraftUnavailableReason
}

export type TerminalDraftConflict = {
  /** The CLI text at the moment the replace was refused; never a screen approximation. */
  text: string
  sourceToken: string
}

type TerminalDraftBeginBase = Pick<
  TerminalDraftCapability,
  'supported' | 'adapter' | 'processIncarnation'
>

export type TerminalDraftBeginResult =
  | (TerminalDraftBeginBase & { ok: true; epoch: number; text: string; sourceToken: string })
  | (TerminalDraftBeginBase & { ok: false; reason: 'locked'; holder: TerminalDraftHolder })
  | (TerminalDraftBeginBase & { ok: false; reason: TerminalDraftUnavailableReason })

export type TerminalDraftHolder = {
  clientId: string
  clientType: 'desktop' | 'mobile'
}

export type TerminalDraftSaveResult =
  | {
      ok: true
      status: 'applied'
      sourceToken: string
      /** False when a previous write applied and the answer was lost; the caller must not retry. */
      replayed?: boolean
      /** The editor's actual text after the write; differs when the CLI normalized tabs/newlines. */
      text?: string
      normalized?: boolean
    }
  | { ok: false; status: 'conflict'; conflict: TerminalDraftConflict }
  | { ok: false; status: 'stale_lease'; epoch: number }
  | { ok: false; status: 'unsupported'; reason: TerminalDraftUnavailableReason }
  | { ok: false; status: 'unknown'; reason: 'bridge_timeout' | 'invalid_bridge_reply' }

export type TerminalDraftSubmitResult =
  | {
      ok: true
      status: 'submitted'
      sourceToken: string
      replayed?: boolean
    }
  | {
      ok: true
      status: 'saved_not_submitted'
      sourceToken: string
      /** Present when the Enter write itself was refused, so no turn started. */
      submitRefused: boolean
      replayed?: boolean
      text?: string
      normalized?: boolean
    }
  | {
      ok: true
      status: 'submit_unknown'
      sourceToken: string
      reason: string
      replayed?: boolean
      text?: string
      normalized?: boolean
    }
  | { ok: false; status: 'conflict'; conflict: TerminalDraftConflict }
  | { ok: false; status: 'stale_lease'; epoch: number }
  | { ok: false; status: 'unsupported'; reason: TerminalDraftUnavailableReason }
  | { ok: false; status: 'unknown'; reason: 'bridge_timeout' | 'invalid_bridge_reply' }
