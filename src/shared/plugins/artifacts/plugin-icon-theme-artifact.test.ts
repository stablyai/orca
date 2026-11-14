import { describe, expect, it } from 'vitest'
import {
  isPluginIconThemeRegistration,
  parsePluginIconThemeArtifact
} from './plugin-icon-theme-artifact'

describe('plugin icon theme artifact prototype keys', () => {
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
