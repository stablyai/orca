// Shared mesh-voice endpoint facts for the desktop speak-back path.
//
// These mirror the mobile voice modules (`mobile/src/voice/`), which are the
// origin of this whole feature. They cannot be imported directly — mobile is a
// separate build with its own aliases — so the constants are restated here with
// this pointer. Keep them in sync with `mobile/src/voice/mesh-voice-turn.ts`.

/** node-a LiteLLM — the canonical audio path (fixed 2026-07-20). NOT node-b. */
export const MESH_VOICE_BASE_URL = 'http://100.92.56.51:4000'

export const KOKORO_TTS_MODEL = 'mesh-tts-kokoro'
export const KOKORO_SAMPLE_RATE = 24000
export const DEFAULT_KOKORO_VOICE = 'af_heart'

/** The mesh assistant arm — same model the pet answers from, so the spoken
 *  summary and the pet's reply come from one voice. See HANDOFF. */
export const SUMMARY_MODEL = 'LFM2.5-8B-A1B-Q4_0.gguf'
