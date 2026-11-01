import { describe, expect, it } from 'vitest'
import {
  isPlausiblePluginIconSvg,
  isPluginIconThemeRegistration,
  parsePluginIconThemeArtifact
} from './plugin-icon-theme-artifact'

const parse = (value: unknown) => parsePluginIconThemeArtifact(JSON.stringify(value), 'strict')

describe('plugin icon theme artifacts', () => {
  it('lowercases name, extension and folder keys', () => {
    expect(
      parse({
        schemaVersion: 1,
        icons: { folder: 'icons/folder.svg' },
        fileNames: { 'README.md': 'icons/readme.svg' },
        fileExtensions: { TS: 'icons/ts.svg' },
        folderNames: { Src: 'icons/src.svg', '.github': 'icons/github.svg' },
        folderNamesExpanded: { SRC: 'icons/src-open.svg' }
      })
    ).toEqual({
      icons: { folder: 'icons/folder.svg' },
      fileNames: { 'readme.md': 'icons/readme.svg' },
      fileExtensions: { ts: 'icons/ts.svg' },
      folderNames: { src: 'icons/src.svg', '.github': 'icons/github.svg' },
      folderNamesExpanded: { src: 'icons/src-open.svg' }
    })
  })

  it('counts folder mappings toward the mapping limit', () => {
    const folderNames = Object.fromEntries(
      Array.from({ length: 257 }, (_, index) => [`dir${index}`, 'a.svg'])
    )
    expect(() =>
      parse({ schemaVersion: 1, folderNames, folderNamesExpanded: folderNames })
    ).toThrow(/mappings/)
  })

  it.each([
    ['a case-only duplicate', { schemaVersion: 1, fileExtensions: { ts: 'a.svg', TS: 'b.svg' } }],
    ['an unknown slot', { schemaVersion: 1, icons: { 'sidebar.search': 'a.svg' } }],
    ['a path in a file name', { schemaVersion: 1, fileNames: { 'a/b': 'a.svg' } }],
    ['a path in a folder name', { schemaVersion: 1, folderNames: { 'a\\b': 'a.svg' } }],
    [
      'a case-only duplicate folder',
      { schemaVersion: 1, folderNamesExpanded: { src: 'a.svg', Src: 'b.svg' } }
    ],
    ['an escaping icon path', { schemaVersion: 1, icons: { file: '../a.svg' } }]
  ])('rejects %s', (_label, value) => {
    expect(() => parse(value)).toThrow()
  })

  it('skips unknown slots at runtime', () => {
    expect(
      parsePluginIconThemeArtifact(
        JSON.stringify({ schemaVersion: 1, icons: { file: 'f.svg', 'sidebar.search': 'a.svg' } })
      ).icons
    ).toEqual({ file: 'f.svg' })
  })
})

describe('plugin icon theme artifact prototype keys', () => {
  it('keeps constructor and __proto__ keys as own data', () => {
    const artifact = parsePluginIconThemeArtifact(
      '{"schemaVersion":1,"fileNames":{"constructor":"a.svg","__proto__":"b.svg"},' +
        '"fileExtensions":{"constructor":"c.svg"}}'
    )
    expect(Object.hasOwn(artifact.fileNames, 'constructor')).toBe(true)
    expect(Object.hasOwn(artifact.fileNames, '__proto__')).toBe(true)
    expect(Object.keys(artifact.fileNames).sort()).toEqual(['__proto__', 'constructor'])
    expect(Object.getPrototypeOf(artifact.fileNames)).toBeNull()
    expect(Object.entries(artifact.fileNames)).toContainEqual(['__proto__', 'b.svg'])
    expect(Object.hasOwn(artifact.fileExtensions, 'constructor')).toBe(true)
  })

  it('accepts a file literally named __proto__ and folds its case', () => {
    for (const key of ['__proto__', '__PROTO__']) {
      const artifact = parsePluginIconThemeArtifact(
        `{"schemaVersion":1,"fileNames":{"${key}":"b.svg"}}`
      )
      expect(Object.entries(artifact.fileNames)).toEqual([['__proto__', 'b.svg']])
    }
    expect(() =>
      parsePluginIconThemeArtifact(
        '{"schemaVersion":1,"fileNames":{"__proto__":"a.svg","__PROTO__":"b.svg"}}'
      )
    ).toThrow(/duplicate/)
  })

  it('rejects case-folded duplicates of prototype names', () => {
    expect(() =>
      parse({ schemaVersion: 1, fileNames: { constructor: 'a.svg', CONSTRUCTOR: 'b.svg' } })
    ).toThrow(/duplicate/)
    expect(() =>
      parse({ schemaVersion: 1, fileExtensions: { constructor: 'a.svg', CONSTRUCTOR: 'b.svg' } })
    ).toThrow(/duplicate/)
  })

  it('does not treat an inherited name as a duplicate of itself', () => {
    expect(() =>
      parse({ schemaVersion: 1, fileNames: { Constructor: 'a.svg', toString: 'b.svg' } })
    ).not.toThrow()
  })
})

describe('isPluginIconThemeRegistration', () => {
  const base = {
    id: 'plugin:samples.icons/minimal',
    pluginKey: 'samples.icons',
    label: 'Minimal',
    svgs: ['<svg/>'],
    icons: {},
    fileExtensions: {},
    folderNames: {},
    folderNamesExpanded: {}
  }

  it.each([
    ['an index past the SVG list', { constructor: 1 }],
    ['a negative index', { constructor: -1 }],
    ['a fractional index', { constructor: 0.5 }]
  ])('rejects %s', (_label, fileNames) => {
    expect(isPluginIconThemeRegistration({ ...base, fileNames })).toBe(false)
  })

  it('checks the range of an own __proto__ index too', () => {
    const fileNames = JSON.parse('{"__proto__":5}')
    expect(isPluginIconThemeRegistration({ ...base, fileNames })).toBe(false)
    expect(
      isPluginIconThemeRegistration({ ...base, fileNames: JSON.parse('{"__proto__":0}') })
    ).toBe(true)
  })

  it('checks folder indexes too', () => {
    expect(
      isPluginIconThemeRegistration({ ...base, fileNames: {}, folderNamesExpanded: { src: 1 } })
    ).toBe(false)
  })

  it('accepts in-range indexes', () => {
    expect(isPluginIconThemeRegistration({ ...base, fileNames: { constructor: 0 } })).toBe(true)
  })
})

describe('isPlausiblePluginIconSvg', () => {
  it.each([
    ['an SVG', '<svg viewBox="0 0 1 1"/>', true],
    ['an XML declaration and comment first', '<?xml version="1.0"?><!-- c --><svg/>', true],
    ['a DOCTYPE', '<!DOCTYPE svg><svg/>', false],
    ['an entity declaration', '<svg><!ENTITY x "y"></svg>', false],
    ['HTML', '<html></html>', false]
  ])('accepts %s: %s', (_label, svg, expected) => {
    expect(isPlausiblePluginIconSvg(svg)).toBe(expected)
  })
})
