import { describe, expect, it } from 'vitest'
import {
  PLUGIN_MANIFEST_VERSION_CURRENT,
  pluginManifestCompatibilityError
} from './plugin-manifest-compatibility'
import { pluginManifestSchema } from './plugin-manifest'

describe('pluginManifestCompatibilityError', () => {
  it('names the Orca a newer plugin needs', () => {
    expect(
      pluginManifestCompatibilityError({ engines: { orca: '>=9.1.0' }, novel: true }, '1.4.0')
    ).toBe('requires Orca >=9.1.0 (this is 1.4.0)')
  })

  it('names a manifest format this build cannot read', () => {
    expect(pluginManifestCompatibilityError({ manifestVersion: 3 }, '1.4.0')).toBe(
      'requires Orca support for manifest format 3 (this is 1.4.0)'
    )
  })

  it('reads the leading floor of a range grammar it does not know', () => {
    expect(pluginManifestCompatibilityError({ engines: { orca: '>=9.0.0 <10' } }, '1.4.0')).toBe(
      'requires Orca >=9.0.0 <10 (this is 1.4.0)'
    )
  })

  it('leaves ordinary mistakes to the schema', () => {
    expect(pluginManifestCompatibilityError({ engines: { orca: '>=1.0.0' } }, '1.4.0')).toBeNull()
    expect(pluginManifestCompatibilityError({ engines: { orca: '^9.0.0' } }, '1.4.0')).toBeNull()
    expect(pluginManifestCompatibilityError({ manifestVersion: 2 }, '1.4.0')).toBeNull()
    expect(pluginManifestCompatibilityError('not a manifest', '1.4.0')).toBeNull()
  })

  it('tracks the newest format the schema accepts', () => {
    expect(
      pluginManifestSchema.def.out.options.map((option) => option.shape.manifestVersion.value)
    ).toContain(PLUGIN_MANIFEST_VERSION_CURRENT)
    expect(
      pluginManifestSchema.def.out.options.every(
        (option) => option.shape.manifestVersion.value <= PLUGIN_MANIFEST_VERSION_CURRENT
      )
    ).toBe(true)
  })
})
