// Status-row presentations for a Codex voice conversation's committed transcript. Who spoke is
// stored as a hint, not text, so each client labels it in its own language.

export const NATIVE_CHAT_VOICE_TRANSCRIPT_PRESENTATIONS = {
  user: 'voice-transcript-user',
  assistant: 'voice-transcript-voice'
} as const

export type NativeChatVoiceTranscriptSpeaker =
  keyof typeof NATIVE_CHAT_VOICE_TRANSCRIPT_PRESENTATIONS

export function nativeChatVoiceTranscriptSpeaker(
  presentation: string | undefined
): NativeChatVoiceTranscriptSpeaker | null {
  return presentation === NATIVE_CHAT_VOICE_TRANSCRIPT_PRESENTATIONS.user
    ? 'user'
    : presentation === NATIVE_CHAT_VOICE_TRANSCRIPT_PRESENTATIONS.assistant
      ? 'assistant'
      : null
}
