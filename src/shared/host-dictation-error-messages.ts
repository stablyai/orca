const DICTATION_SESSION_LOST_MESSAGE = 'Dictation lost its connection to the computer. Try again.'
const HOST_DICTATION_ERROR_MESSAGES: ReadonlyMap<string, string> = new Map([
  // The host has one speech model, so one dictation runs at a time across the computer and every phone.
  ['dictation_already_active', 'Dictation is already in use on the computer or another phone.'],
  ['dictation_requires_mobile_client', 'Re-pair this phone with the computer to use dictation.'],
  ['dictation_owner_mismatch', DICTATION_SESSION_LOST_MESSAGE],
  ['dictation_stream_not_started', DICTATION_SESSION_LOST_MESSAGE],
  ['dictation_stream_closing', DICTATION_SESSION_LOST_MESSAGE]
])

// Shared by desktop and mobile so a host refusal reads the same on both.
export function hostDictationErrorMessage(code: string): string | undefined {
  return HOST_DICTATION_ERROR_MESSAGES.get(code)
}
