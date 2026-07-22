// Desktop mirror of `mobile/src/voice/kokoro-voices.ts` — same schema, same
// voice-id semantics, same fallback list, same preview line. Mobile cannot
// import from this module (separate build, different aliases) and we cannot
// import from mobile, so the two files mirror each other verbatim where the
// logic is pure. The persistence half differs intentionally: mobile uses
// AsyncStorage, desktop reads `VoiceSettings.kokoroVoice` from GlobalSettings.
//
// Why a mirror and not a shared helper: src/shared/ is reachable from the
// renderer's tsconfig but not from mobile's Expo bundler. Putting the logic
// in src/shared/ would help only the desktop side and force mobile to keep
// its own copy anyway. The "extract a shared helper" branch only beats the
// mirror when both builds can import the same module.

import { DEFAULT_KOKORO_VOICE, kokoroDirectBaseUrlFor } from './mesh-speech-config'

export const KOKORO_VOICE_DEFAULT_ID = DEFAULT_KOKORO_VOICE

// Kokoro encodes language and gender in the id prefix: <lang><gender>_<name>.
// Kept in lockstep with the mobile table so a picker row on either surface
// reads the same.
const LANGUAGE_LABELS: Record<string, string> = {
  a: 'American English',
  b: 'British English',
  e: 'Spanish',
  f: 'French',
  h: 'Hindi',
  i: 'Italian',
  j: 'Japanese',
  p: 'Portuguese',
  z: 'Chinese'
}

export type KokoroVoice = {
  id: string
  /** Name with the prefix stripped and capitalised, e.g. `af_heart` -> "Heart". */
  label: string
  language: string
  gender: 'female' | 'male' | 'unknown'
}

export function describeVoiceId(id: string): KokoroVoice {
  const [prefix, ...rest] = id.split('_')
  const name = rest.join('_') || id
  const language = LANGUAGE_LABELS[prefix?.[0] ?? ''] ?? 'Other'
  const genderChar = prefix?.[1]
  return {
    id,
    label: name.charAt(0).toUpperCase() + name.slice(1),
    language,
    gender: genderChar === 'f' ? 'female' : genderChar === 'm' ? 'male' : 'unknown'
  }
}

/**
 * Voices to fall back on when the catalogue cannot be fetched — a small, known
 * spread rather than the whole list, so an offline settings screen still offers
 * a real choice instead of an empty picker. Identical to the mobile list so a
 * desktop user picking offline sees the same rows a mobile user would.
 */
export const FALLBACK_VOICE_IDS = [
  'af_heart',
  'af_bella',
  'af_nicole',
  'am_michael',
  'am_onyx',
  'bf_emma',
  'bm_george'
]

export async function fetchKokoroVoices(
  hostEndpoint?: string | null,
  signal?: AbortSignal
): Promise<KokoroVoice[]> {
  try {
    const res = await fetch(`${kokoroDirectBaseUrlFor(hostEndpoint)}/v1/audio/voices`, { signal })
    if (!res.ok) {
      throw new Error(`voices ${res.status}`)
    }
    const body = (await res.json()) as { voices?: ({ id?: string } | string)[] }
    const ids = (body.voices ?? [])
      .map((entry) => (typeof entry === 'string' ? entry : entry.id))
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
    if (ids.length === 0) {
      throw new Error('voices list empty')
    }
    return ids.map(describeVoiceId)
  } catch {
    // Why swallow: a settings screen that cannot reach the mesh should still let
    // the operator pick from known-good voices, not show an error and nothing.
    return FALLBACK_VOICE_IDS.map(describeVoiceId)
  }
}

/** Speak a short sample so the operator can hear a voice before committing. */
export function voicePreviewText(voice: KokoroVoice): string {
  return `Hi, I'm ${voice.label}. This is how I'll read your replies.`
}
