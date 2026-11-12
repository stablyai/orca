// The Codex app-server's thread-scoped realtime voice: a separate conversational voice model that
// hands work to the chat's own thread. The renderer owns the media; the host only relays signaling.

/** Codex's helper bounds SDP at 64 KiB; a larger offer is not a browser offer. */
export const AGENT_SESSION_VOICE_OFFER_MAX_LENGTH = 64 * 1024

export const AGENT_SESSION_VOICE_END_REASONS = [
  'requested',
  'transport-closed',
  'error',
  'answer-timeout',
  'provider-exited'
] as const
export type AgentSessionVoiceEndReason = (typeof AGENT_SESSION_VOICE_END_REASONS)[number]

/** Why a start never reached the provider. */
export type AgentSessionVoiceRefusal = 'busy' | 'not-running' | 'unsupported'

export type AgentSessionVoiceEvent =
  /** The provider created the call; the renderer applies this as the peer's remote answer. */
  | { type: 'answer'; sdp: string }
  /** A caption's current text, keyed by the provider's realtime item id. */
  | {
      type: 'transcript'
      itemId: string
      role: 'user' | 'assistant'
      text: string
      final: boolean
    }
  | { type: 'error'; message: string }
  /** Terminal: no frame follows, and the provider's session is being stopped. */
  | { type: 'ended'; reason: AgentSessionVoiceEndReason }
  /** Terminal: nothing was started. */
  | { type: 'refused'; reason: AgentSessionVoiceRefusal }
