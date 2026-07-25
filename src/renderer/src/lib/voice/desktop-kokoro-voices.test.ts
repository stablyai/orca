import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_MESH_VOICE_HOST,
  KOKORO_VOICE_STORAGE_KEY,
  kokoroDirectBaseUrlFor
} from './mesh-speech-config'
import {
  FALLBACK_VOICE_IDS,
  describeVoiceId,
  fetchKokoroVoices,
  voicePreviewText
} from './desktop-kokoro-voices'

afterEach(() => {
  vi.unstubAllGlobals()
})

function mockJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

function stubFetch(handler: () => Promise<Response>): ReturnType<typeof vi.fn> {
  const mock = vi.fn(handler)
  vi.stubGlobal('fetch', mock as unknown as typeof fetch)
  return mock
}

describe('desktop-kokoro-voices', () => {
  describe('shared schema contract', () => {
    // Why: the design doc asserts parity between this module and
    // mobile/src/voice/kokoro-voices.ts via tests on each side. Drift here is a
    // user-visible bug (mobile and desktop showing different rows for the same
    // id), so the assertions spell out the literal values.
    it('uses the same storage key as mobile', () => {
      expect(KOKORO_VOICE_STORAGE_KEY).toBe('orca:kokoroVoice')
    })

    it('builds the Kokoro-direct URL on the supplied host (port 8880)', () => {
      expect(kokoroDirectBaseUrlFor('ws://node-c.tailnet:6768')).toBe(
        'http://node-c.tailnet:8880'
      )
    })

    it('falls back to the documented default when no host is supplied', () => {
      expect(kokoroDirectBaseUrlFor(null)).toBe(
        `http://${DEFAULT_MESH_VOICE_HOST}:8880`
      )
    })
  })

  describe('describeVoiceId', () => {
    it('decodes American English / female / "af_heart" -> Heart', () => {
      expect(describeVoiceId('af_heart')).toEqual({
        id: 'af_heart',
        label: 'Heart',
        language: 'American English',
        gender: 'female'
      })
    })

    it('decodes British English / male / "bm_george"', () => {
      expect(describeVoiceId('bm_george')).toEqual({
        id: 'bm_george',
        label: 'George',
        language: 'British English',
        gender: 'male'
      })
    })

    it('decodes every supported language prefix', () => {
      const cases: [string, string][] = [
        ['am_michael', 'American English'],
        ['af_bella', 'American English'],
        ['bf_emma', 'British English'],
        ['es_alex', 'Spanish'],
        ['ff_siwah', 'French'],
        ['hf_alpha', 'Hindi'],
        ['if_sara', 'Italian'],
        ['jf_gongitsune', 'Japanese'],
        ['pf_dora', 'Portuguese'],
        ['zf_xiaobei', 'Chinese']
      ]
      for (const [id, language] of cases) {
        expect(describeVoiceId(id).language).toBe(language)
      }
    })

    it('marks unknown prefix letters and non-f/m gender as "Other"/"unknown"', () => {
      expect(describeVoiceId('xx_unknown')).toEqual({
        id: 'xx_unknown',
        label: 'Unknown',
        language: 'Other',
        gender: 'unknown'
      })
    })

    it('falls back to the raw id when the underscore separator is missing', () => {
      // Why: voice ids from Kokoro always have an underscore, but the parser
      // must not throw on a malformed value; the renderer may receive one
      // from an upstream schema change.
      const result = describeVoiceId('solo')
      expect(result.id).toBe('solo')
      expect(result.label).toBe('Solo')
    })
  })

  describe('FALLBACK_VOICE_IDS', () => {
    it('matches the mobile-side list verbatim', () => {
      expect(FALLBACK_VOICE_IDS).toEqual([
        'af_heart',
        'af_bella',
        'af_nicole',
        'am_michael',
        'am_onyx',
        'bf_emma',
        'bm_george'
      ])
    })
  })

  describe('fetchKokoroVoices', () => {
    it('maps a 200 response with object-form voices through describeVoiceId', async () => {
      const fetchMock = stubFetch(async () =>
        mockJsonResponse({ voices: [{ id: 'af_heart' }, { id: 'am_onyx' }] })
      )

      const voices = await fetchKokoroVoices('ws://mesh.local:6768')

      expect(voices.map((v) => v.id)).toEqual(['af_heart', 'am_onyx'])
      expect(voices[0]).toMatchObject({ label: 'Heart', language: 'American English' })
      expect(fetchMock).toHaveBeenCalledWith(
        'http://mesh.local:8880/v1/audio/voices',
        { signal: undefined }
      )
    })

    it('accepts string-form voice entries', async () => {
      stubFetch(async () => mockJsonResponse({ voices: ['af_heart', 'am_onyx'] }))

      const voices = await fetchKokoroVoices(null)

      expect(voices.map((v) => v.id)).toEqual(['af_heart', 'am_onyx'])
    })

    it('returns fallback voices on a non-2xx response', async () => {
      stubFetch(async () => mockJsonResponse({}, 502))

      const voices = await fetchKokoroVoices(null)

      expect(voices.map((v) => v.id)).toEqual(FALLBACK_VOICE_IDS)
    })

    it('returns fallback voices on a network error', async () => {
      stubFetch(async () => {
        throw new Error('network down')
      })

      const voices = await fetchKokoroVoices(null)

      expect(voices.map((v) => v.id)).toEqual(FALLBACK_VOICE_IDS)
    })

    it('returns fallback voices when the response body has no voices', async () => {
      stubFetch(async () => mockJsonResponse({ voices: [] }))

      const voices = await fetchKokoroVoices(null)

      expect(voices.map((v) => v.id)).toEqual(FALLBACK_VOICE_IDS)
    })
  })

  describe('voicePreviewText', () => {
    it('produces the same line as the mobile-side preview helper', () => {
      const voice = describeVoiceId('af_heart')
      expect(voicePreviewText(voice)).toBe(
        "Hi, I'm Heart. This is how I'll read your replies."
      )
    })
  })
})
