export const DICTATION_SESSION_LOST_MESSAGE =
  'Dictation lost its connection to the computer. Try again.'
const HOST_DICTATION_ERROR_MESSAGES: ReadonlyMap<string, string> = new Map([
  // Only hosts older than per-device sessions refuse a second device this way.
  [
    'dictation_already_active',
    'Dictation is already in use on the computer or another phone. Update Orca on the computer to dictate from several devices at once.'
  ],
  [
    'dictation_session_limit',
    'Too many devices are dictating on this computer. Try again when one finishes.'
  ],
  [
    'dictation_model_busy',
    'Another device is dictating with a different speech model. Try again when it finishes.'
  ],
  ['dictation_requires_mobile_client', 'Re-pair this phone with the computer to use dictation.'],
  ['dictation_owner_mismatch', DICTATION_SESSION_LOST_MESSAGE],
  ['dictation_stream_not_started', DICTATION_SESSION_LOST_MESSAGE],
  ['dictation_stream_closing', DICTATION_SESSION_LOST_MESSAGE]
])

// Shared by desktop and mobile so a host refusal reads the same on both.
export function hostDictationErrorMessage(code: string): string | undefined {
  return HOST_DICTATION_ERROR_MESSAGES.get(code)
}
