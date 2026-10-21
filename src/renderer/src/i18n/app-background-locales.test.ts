import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import en from './locales/en.json'
import es from './locales/es.json'
import fr from './locales/fr.json'
import ja from './locales/ja.json'
import ko from './locales/ko.json'
import zh from './locales/zh.json'

const catalogs = { en, es, fr, ja, ko, zh }
const KEY_PREFIX = 'settings.appearance.background.'
const SOURCE_FILES = [
  '../components/settings/AppearanceBackgroundSection.tsx',
  '../components/settings/AppBackgroundPreview.tsx',
  '../components/settings/appearance-background-search.ts',
  '../../../main/ipc/app-background.ts'
]

// Why: the catalog gate tolerates missing non-English keys, so this pins full coverage for the feature.
function referencedKeys(): string[] {
  const keys = new Set<string>()
  for (const file of SOURCE_FILES) {
    const source = readFileSync(path.join(__dirname, file), 'utf8')
    for (const match of source.matchAll(/'(settings\.appearance\.background\.[\w.]+)'/g)) {
      keys.add(match[1])
    }
  }
  return [...keys].sort()
}

function lookup(catalog: unknown, key: string): unknown {
  let node: unknown = catalog
  for (const segment of key.split('.')) {
    if (typeof node !== 'object' || node === null) {
      return undefined
    }
    node = Object.entries(node).find(([name]) => name === segment)?.[1]
  }
  return node
}

describe('app background locale copy', () => {
  it('finds the feature keys in source', () => {
    expect(referencedKeys().length).toBeGreaterThan(30)
  })

  it.each(Object.entries(catalogs))('%s has every background settings key', (_code, catalog) => {
    const missing = referencedKeys().filter((key) => {
      const value = lookup(catalog, key)
      return typeof value !== 'string' || value.trim() === ''
    })
    expect(missing).toEqual([])
  })

  it.each(Object.entries({ es, fr, ja, ko, zh }))(
    '%s translates the section title and description',
    (_code, catalog) => {
      for (const key of ['title', 'description', 'unapplied']) {
        expect(lookup(catalog, `${KEY_PREFIX}${key}`)).not.toBe(lookup(en, `${KEY_PREFIX}${key}`))
      }
    }
  )
})
