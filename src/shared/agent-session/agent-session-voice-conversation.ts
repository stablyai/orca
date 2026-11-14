// The Codex app-server's thread-scoped realtime voice: a separate conversational voice model that
// hands work to the chat's own thread. The renderer owns the media; the host only relays signaling.

/** Codex's helper bounds SDP at 64 KiB; a larger offer is not a browser offer. */
export const AGENT_SESSION_VOICE_OFFER_MAX_LENGTH = 64 * 1024

/** A voice name as Codex's `thread/realtime/listVoices` reports it; Codex owns which ones exist. */
export const AGENT_SESSION_VOICE_NAME_PATTERN = /^[a-z0-9_-]{1,64}$/

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
  /** This Codex does not offer the preferred voice, so the call uses Codex's default voice. */
  | { type: 'voice-unavailable'; voice: string }
  /** Terminal: no frame follows, and the provider's session is being stopped. */
  | { type: 'ended'; reason: AgentSessionVoiceEndReason }
  /** Terminal: nothing was started. */
  | { type: 'refused'; reason: AgentSessionVoiceRefusal }

/** Voices this chat's Codex offers for the realtime version Orca starts; null when it cannot list. */
export type AgentSessionCodexVoices = { voices: string[] | null }
