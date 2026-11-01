import { describe, expect, it } from 'vitest'
import { resolvePluralFamilyKey, withPluralCategoriesFromOther } from './i18n-plural-family'

describe('resolvePluralFamilyKey', () => {
  it('strips plural suffix when count is a number', () => {
    expect(resolvePluralFamilyKey('items_one', { count: 1 })).toBe('items')
    expect(resolvePluralFamilyKey('items_other', { count: 5 })).toBe('items')
    expect(resolvePluralFamilyKey('items_few', { count: 2 })).toBe('items')
    expect(resolvePluralFamilyKey('items_many', { count: 20 })).toBe('items')
    expect(resolvePluralFamilyKey('items_zero', { count: 0 })).toBe('items')
    expect(resolvePluralFamilyKey('items_two', { count: 2 })).toBe('items')
  })

  it('preserves key when count is missing or not a number', () => {
    expect(resolvePluralFamilyKey('items_one')).toBe('items_one')
    expect(resolvePluralFamilyKey('items_one', {})).toBe('items_one')
    expect(resolvePluralFamilyKey('items_one', { count: '1' as unknown as number })).toBe(
      'items_one'
    )
  })

  it('leaves keys without recognized plural suffixes intact even with count', () => {
    expect(resolvePluralFamilyKey('item_name', { count: 3 })).toBe('item_name')
    expect(resolvePluralFamilyKey('simple', { count: 1 })).toBe('simple')
  })
})

describe('withPluralCategoriesFromOther', () => {
  it('fills missing categories from _other keys', () => {
    const catalog = {
      files_other: '{{count}} files',
      title: 'Files'
    }
    const result = withPluralCategoriesFromOther(catalog, ['one', 'few', 'many'])
    expect(result).toEqual({
      files_other: '{{count}} files',
      files_one: '{{count}} files',
      files_few: '{{count}} files',
      files_many: '{{count}} files',
      title: 'Files'
    })
  })

  it('does not overwrite existing category forms', () => {
    const catalog = {
      files_one: '{{count}} file',
      files_other: '{{count}} files'
    }
    const result = withPluralCategoriesFromOther(catalog, ['one', 'few', 'many'])
    expect(result).toEqual({
      files_one: '{{count}} file',
      files_other: '{{count}} files',
      files_few: '{{count}} files',
      files_many: '{{count}} files'
    })
  })

  it('recursively processes nested catalog objects', () => {
    const catalog = {
      nested: {
        items_other: '{{count}} items'
      },
      arrayVal: [1, 2, 3]
    }
    const result = withPluralCategoriesFromOther(catalog, ['one', 'few'])
    expect(result).toEqual({
      nested: {
        items_other: '{{count}} items',
        items_one: '{{count}} items',
        items_few: '{{count}} items'
      },
      arrayVal: [1, 2, 3]
    })
  })
})
