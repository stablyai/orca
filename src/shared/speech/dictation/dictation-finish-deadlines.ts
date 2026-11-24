// Cloud uploads are one 16 kHz 16-bit mono WAV, capped at 10 minutes per dictation.
export const CLOUD_TRANSCRIPTION_SAMPLE_RATE = 16_000
export const MAX_CLOUD_TRANSCRIPTION_SECONDS = 10 * 60
const WAV_HEADER_BYTES = 44
// Room to answer plus the upload time of the WAV at 1 Mbit/s (125 bytes per ms).
const CLOUD_RESPONSE_ALLOWANCE_MS = 30_000
const UPLOAD_BYTES_PER_MS = 125

// A finishing on-device dictation fails once the engine goes this long without answering.
export const LOCAL_DICTATION_STOP_TIMEOUT_MS = 60_000
// How long an on-device model may take to load before its dictation fails.
export const START_DICTATION_TIMEOUT_MS = 60_000
// The host's answer still has to cross the network after its own deadline.
const PAIRED_CLIENT_REPLY_MARGIN_MS = 15_000

/** How long the host lets a cloud upload of this many 16 kHz samples run before failing it. */
export function cloudTranscriptionTimeoutMs(audioSamples: number): number {
  const wavBytes = WAV_HEADER_BYTES + audioSamples * 2
  return CLOUD_RESPONSE_ALLOWANCE_MS + Math.ceil(wavBytes / UPLOAD_BYTES_PER_MS)
}

/** A paired phone or browser waits out the host's cloud deadline for this much audio, or at least one local stop window. */
export function pairedDictationFinishTimeoutMs(audioSeconds: number): number {
  const seconds = Math.min(audioSeconds, MAX_CLOUD_TRANSCRIPTION_SECONDS)
  const cloudMs = cloudTranscriptionTimeoutMs(Math.ceil(seconds * CLOUD_TRANSCRIPTION_SAMPLE_RATE))
  return Math.max(LOCAL_DICTATION_STOP_TIMEOUT_MS, cloudMs) + PAIRED_CLIENT_REPLY_MARGIN_MS
}
