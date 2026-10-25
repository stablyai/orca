import { describe, expect, it } from 'vitest'
import { assertPluginSourceUnderByteCap, PLUGIN_SOURCE_MAX_BYTES } from './plugin-source-limit'

describe('plugin source byte limit', () => {
  it('allows non-string values because installPlugins treats them as absent sources', () => {
    expect(() => assertPluginSourceUnderByteCap('piExtensionSource', undefined)).not.toThrow()
  })

  it('allows sources at the byte cap', () => {
    const source = 'a'.repeat(PLUGIN_SOURCE_MAX_BYTES)

    expect(() => assertPluginSourceUnderByteCap('opencodePluginSource', source)).not.toThrow()
  })

  it('rejects sources over the byte cap using utf8 byte length, not string length', () => {
    const source = 'é'.repeat(Math.floor(PLUGIN_SOURCE_MAX_BYTES / 2) + 1)

    expect(source.length).toBeLessThanOrEqual(PLUGIN_SOURCE_MAX_BYTES)
    expect(Buffer.byteLength(source, 'utf8')).toBeGreaterThan(PLUGIN_SOURCE_MAX_BYTES)
    expect(() => assertPluginSourceUnderByteCap('piExtensionSource', source)).toThrow(
      `piExtensionSource exceeds ${PLUGIN_SOURCE_MAX_BYTES} byte cap`
    )
  })
})
