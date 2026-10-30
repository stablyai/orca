import { describe, expect, it } from 'vitest'
import { pluginCategoryLabel } from './plugin-category-label'

describe('pluginCategoryLabel', () => {
  it('names folded kinds and known standalone categories through the catalog', () => {
    expect(pluginCategoryLabel('vm-recipes')).toBe('Remote/VMs')
    expect(pluginCategoryLabel('games')).toBe('Games')
    expect(pluginCategoryLabel('integrations')).toBe('Integrations')
  })

  it('turns unknown slugs into words', () => {
    expect(pluginCategoryLabel('music-tools')).toBe('Music Tools')
  })
})
