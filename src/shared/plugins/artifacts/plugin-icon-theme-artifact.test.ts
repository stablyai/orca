import { describe, expect, it } from 'vitest'
import {
  isPluginIconThemeRegistration,
  parsePluginIconThemeArtifact
} from './plugin-icon-theme-artifact'

const parse = (value: unknown) => parsePluginIconThemeArtifact(JSON.stringify(value), 'strict')

describe('plugin icon theme artifacts', () => {
  it('counts folder mappings toward the mapping limit', () => {
    const folderNames = Object.fromEntries(
      Array.from({ length: 257 }, (_, index) => [`dir${index}`, 'a.svg'])
    )
    expect(() =>
      parse({ schemaVersion: 1, folderNames, folderNamesExpanded: folderNames })
    ).toThrow(/mappings/)
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

  it('checks the range of an own __proto__ index too', () => {
    const fileNames = JSON.parse('{"__proto__":5}')
    expect(isPluginIconThemeRegistration({ ...base, fileNames })).toBe(false)
    expect(
      isPluginIconThemeRegistration({ ...base, fileNames: JSON.parse('{"__proto__":0}') })
    ).toBe(true)
  })
})
