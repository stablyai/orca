import { describe, expect, it } from 'vitest'
import { isCatalogObject } from './i18n-catalog-object'
import { isCatalogObject as isCatalogObjectReexported } from './plugins/artifacts/plugin-language-pack-artifact'

describe('isCatalogObject', () => {
  it('returns true for plain object literals and Object.create(Object.prototype)', () => {
    expect(isCatalogObject({})).toBe(true)
    expect(isCatalogObject({ a: 1, b: 'nested' })).toBe(true)
    expect(isCatalogObject(Object.create(Object.prototype))).toBe(true)
  })

  it('returns false for primitives, null, and undefined', () => {
    expect(isCatalogObject(null)).toBe(false)
    expect(isCatalogObject(undefined)).toBe(false)
    expect(isCatalogObject(123)).toBe(false)
    expect(isCatalogObject('hello')).toBe(false)
    expect(isCatalogObject(true)).toBe(false)
    expect(isCatalogObject(Symbol('key'))).toBe(false)
    expect(isCatalogObject(10n)).toBe(false)
  })

  it('returns false for arrays and functions', () => {
    expect(isCatalogObject([])).toBe(false)
    expect(isCatalogObject([1, 2, 3])).toBe(false)
    expect(isCatalogObject(() => {})).toBe(false)
  })

  it('returns false for objects with non-Object.prototype prototypes', () => {
    expect(isCatalogObject(Object.create(null))).toBe(false)
    expect(isCatalogObject(new Date())).toBe(false)
    expect(isCatalogObject(new Set())).toBe(false)
    expect(isCatalogObject(new Map())).toBe(false)
    class Custom {}
    expect(isCatalogObject(new Custom())).toBe(false)
  })

  it('is identically re-exported by the plugin language-pack artifact validator', () => {
    expect(isCatalogObjectReexported).toBe(isCatalogObject)
  })
})
