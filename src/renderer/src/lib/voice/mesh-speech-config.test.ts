import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MESH_VOICE_HOST,
  extractMeshHost,
  meshVoiceBaseUrlFor
} from './mesh-speech-config'

describe('mesh-speech-config', () => {
  describe('extractMeshHost', () => {
    it('returns the hostname of a ws URL', () => {
      expect(extractMeshHost('ws://100.92.56.51:6768')).toBe('100.92.56.51')
    })

    it('returns the hostname of a wss URL', () => {
      expect(extractMeshHost('wss://mesh.local:8443')).toBe('mesh.local')
    })

    it('returns null for nullish input', () => {
      expect(extractMeshHost(null)).toBeNull()
      expect(extractMeshHost(undefined)).toBeNull()
    })

    it('returns null for an unparseable input', () => {
      expect(extractMeshHost('not a url at all')).toBeNull()
    })
  })

  describe('meshVoiceBaseUrlFor', () => {
    it('builds the LiteLLM proxy URL on the supplied host', () => {
      expect(meshVoiceBaseUrlFor('ws://node-b.tailnet:6768')).toBe(
        'http://node-b.tailnet:4000'
      )
    })

    it('falls back to the documented default when no host is supplied', () => {
      expect(meshVoiceBaseUrlFor(null)).toBe(`http://${DEFAULT_MESH_VOICE_HOST}:4000`)
    })
  })
})
