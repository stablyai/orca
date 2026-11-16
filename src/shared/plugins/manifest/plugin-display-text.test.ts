import { describe, expect, it } from 'vitest'
import { validatePluginFile } from '../installation/plugin-file-validation'
import { pluginCatalogEntrySchema } from '../catalog/plugin-catalog'
import { parseHostPluginManifest } from './plugin-manifest'
import {
  catalogEntryFixture,
  catalogFixture,
  v2ManifestFixture
} from './plugin-json-schema.test-fixture'

// "Dusk", a right-to-left override that renders "Official" backwards, and a zero-width space.
const SPOOFED_NAME = 'Dusk \u202elaiciffO\u202c\u200b'
const themed = (name: string, title: string) =>
  v2ManifestFixture({
    name,
    description: 'Line one\nline two',
    contributes: { themes: [{ id: 'dusk', title, path: 'dusk.json' }] }
  })

describe('plugin display text', () => {
  it('strips bidi, zero-width and line-break characters when a host reads a manifest', () => {
    const parsed = parseHostPluginManifest(themed(SPOOFED_NAME, 'Dusk\u2066 Pro'))
    expect(parsed.ok && parsed.manifest).toMatchObject({
      name: 'Dusk laiciffO',
      description: 'Line one line two',
      contributes: { themes: [{ title: 'Dusk Pro' }] }
    })
  })

  it('strips catalog listing text at runtime and refuses it in catalog CI', () => {
    const entry = catalogEntryFixture({ description: 'Gleam\u202e' }, { name: 'Gleam\u200b' })
    expect(pluginCatalogEntrySchema.parse(entry)).toMatchObject({
      description: 'Gleam',
      releases: [{ name: 'Gleam' }]
    })
    expect(validatePluginFile('orca-catalog.json', catalogFixture([entry]))).toEqual([
      'plugins[0].releases[0].name: must be one line without control, bidirectional or zero-width characters',
      'plugins[0].description: must be one line without control, bidirectional or zero-width characters'
    ])
  })
})
