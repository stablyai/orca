// Shared mesh-voice endpoint facts for the desktop speak-back path.
//
// These mirror the mobile voice modules (`mobile/src/voice/`), which are the
// origin of this whole feature. They cannot be imported directly — mobile is a
// separate build with its own aliases — so the constants and resolver are
// restated here with this pointer. Keep them in sync with
// `mobile/src/voice/mesh-voice-endpoint.ts`.

/** Last-resort fallback used only when the renderer has no paired host to
 *  read the mesh URL from. Mirrors the mobile-side `DEFAULT_MESH_VOICE_HOST`
 *  so a desktop on the same Tailscale network still hits the same node. */
export const DEFAULT_MESH_VOICE_HOST = '100.92.56.51'

/** LiteLLM synth proxy port — /v1/audio/speech, /v1/chat/completions. */
const MESH_VOICE_PROXY_PORT = 4000

/** Kokoro's own API — /v1/audio/voices (the proxy does not expose this). */
const KOKORO_DIRECT_PORT = 8880

export const KOKORO_TTS_MODEL = 'mesh-tts-kokoro'
export const KOKORO_SAMPLE_RATE = 24000
export const DEFAULT_KOKORO_VOICE = 'af_heart'

/** Shared storage identifier for the selected Kokoro voice. Mirrors mobile's
 *  `VOICE_STORAGE_KEY` in `mobile/src/voice/kokoro-voices.ts`. Mobile and
 *  desktop are separate builds; this is the contract string both sides spell
 *  identically (asserted by tests on each side and by `grep` in the design
 *  doc's Test Plan). */
export const KOKORO_VOICE_STORAGE_KEY = 'orca:kokoroVoice'

/** The mesh assistant arm — same model the pet answers from, so the spoken
 *  summary and the pet's reply come from one voice. See HANDOFF. */
export const SUMMARY_MODEL = 'LFM2.5-8B-A1B-Q4_0.gguf'

/** Extract the host portion of a `ws://host:port/...` mesh endpoint. Returns
 *  null when the input is not a parseable URL with a hostname — caller falls
 *  back to the default in that case. */
export function extractMeshHost(endpoint: string | null | undefined): string | null {
  if (!endpoint) {
    return null
  }
  try {
    const url = new URL(endpoint)
    if (!url.hostname) {
      return null
    }
    return url.hostname
  } catch {
    const trimmed = endpoint.trim()
    if (trimmed.length > 0 && !/\s/.test(trimmed)) {
      return trimmed
    }
    return null
  }
}

/** URL of the LiteLLM proxy (text→speech + chat completions) for the given
 *  paired host endpoint, or the default host when no host is supplied. */
export function meshVoiceBaseUrlFor(hostEndpoint: string | null | undefined): string {
  const host = extractMeshHost(hostEndpoint) ?? DEFAULT_MESH_VOICE_HOST
  return `http://${host}:${MESH_VOICE_PROXY_PORT}`
}

/** URL of the Kokoro-direct catalogue (`/v1/audio/voices`) for the given
 *  paired host endpoint, or the default host when no host is supplied.
 *  Mirrors `kokoroDirectBaseUrlFor` in `mobile/src/voice/mesh-voice-endpoint.ts`. */
export function kokoroDirectBaseUrlFor(hostEndpoint: string | null | undefined): string {
  const host = extractMeshHost(hostEndpoint) ?? DEFAULT_MESH_VOICE_HOST
  return `http://${host}:${KOKORO_DIRECT_PORT}`
}
