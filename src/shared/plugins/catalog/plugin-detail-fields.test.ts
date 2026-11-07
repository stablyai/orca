import { describe, expect, it } from 'vitest'

import { pluginCatalogReleaseSchema } from './plugin-catalog-release'

const release = {
  version: '1.2.0',
  commit: 'c'.repeat(40),
  contentHash: 'f'.repeat(64),
  execution: 'data',
  minimumOrca: '1.4.0',
  types: ['interface-language']
}

describe('plugin detail fields', () => {
  it('drops invalid catalog release details instead of hiding the release', () => {
    const parsed = pluginCatalogReleaseSchema.parse({
      ...release,
      license: 'MIT; rm -rf',
      repository: 'http://github.com/acme/demo',
      homepage: 'javascript:alert(1)',
      updatedAt: 'last week',
      changelog: 'x'.repeat(2_001)
    })
    expect(parsed.license).toBeUndefined()
    expect(parsed.repository).toBeUndefined()
    expect(parsed.homepage).toBeUndefined()
    expect(parsed.updatedAt).toBeUndefined()
    expect(parsed.changelog).toBeUndefined()
  })
})
