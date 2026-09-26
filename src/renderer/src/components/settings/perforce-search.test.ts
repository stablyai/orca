import { describe, expect, it } from 'vitest'
import { getPerforcePaneSearchEntries, getPerforceSettingsCatalog } from './perforce-search'

describe('Perforce settings search catalog', () => {
  it('describes every setting with a unique id and searchable text', () => {
    const catalog = getPerforceSettingsCatalog()
    expect(catalog).toHaveLength(16)
    expect(new Set(catalog.map((item) => item.id)).size).toBe(catalog.length)
    for (const item of catalog) {
      expect(item.title.length).toBeGreaterThan(0)
      expect(item.description?.length ?? 0).toBeGreaterThan(0)
      expect(item.keywords).toContain('perforce')
    }
  })

  it('exposes entries without the internal id for the nav search index', () => {
    expect(getPerforcePaneSearchEntries().every((entry) => !('id' in entry))).toBe(true)
  })
})
