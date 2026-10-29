import { describe, expect, it } from 'vitest'
import { File } from 'lucide-react'
import { parsePluginIconThemeArtifact } from '../../../shared/plugins/artifacts/plugin-icon-theme-artifact'
import { getFileTypeIcon, getPluginFileTypeIconIndex } from './file-type-icons'

describe('getFileTypeIcon', () => {
  it.each([
    'constructor',
    '__proto__',
    'toString',
    'hasOwnProperty',
    'x.constructor',
    'x.__proto__'
  ])('falls back to the generic file icon for %s', (name) => {
    expect(getFileTypeIcon(`/a/${name}`)).toBe(File)
  })
})

describe('parsed artifact lookup', () => {
  it('finds files named __proto__ and constructor from the parsed theme', () => {
    const artifact = parsePluginIconThemeArtifact(
      '{"schemaVersion":1,"fileNames":{"__proto__":"a.svg","Constructor":"b.svg"}}'
    )
    const indexes = Object.fromEntries(
      Object.keys(artifact.fileNames).map((key, index) => [key, index])
    )
    const theme = { icons: {}, fileNames: indexes, fileExtensions: {} }
    expect(getPluginFileTypeIconIndex(theme, '/a/__proto__')).toBe(0)
    expect(getPluginFileTypeIconIndex(theme, '/a/CONSTRUCTOR')).toBe(1)
    expect(getPluginFileTypeIconIndex(theme, '/a/other')).toBeNull()
  })
})

describe('getPluginFileTypeIconIndex', () => {
  const theme = {
    icons: { file: 3 },
    fileNames: { 'readme.md': 1, ['__proto__']: 4 },
    fileExtensions: { ts: 2 }
  }

  it('matches exact names, then extensions, then the file icon', () => {
    expect(getPluginFileTypeIconIndex(theme, '/a/README.md')).toBe(1)
    expect(getPluginFileTypeIconIndex(theme, '/a/x.TS')).toBe(2)
  })

  it('matches the longest dotted extension the theme maps', () => {
    const multi = { icons: {}, fileNames: {}, fileExtensions: { 'd.ts': 5, ts: 2, gz: 6 } }
    expect(getPluginFileTypeIconIndex(multi, '/a/types.d.ts')).toBe(5)
    expect(getPluginFileTypeIconIndex(multi, '/a/index.ts')).toBe(2)
    expect(getPluginFileTypeIconIndex(multi, '/a/archive.tar.gz')).toBe(6)
    expect(getPluginFileTypeIconIndex(theme, '/a/x.unknown')).toBe(3)
  })

  it('ignores inherited Object.prototype names', () => {
    const noFile = { icons: {}, fileNames: {}, fileExtensions: {} }
    for (const name of ['constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(getPluginFileTypeIconIndex(noFile, `/a/${name}`)).toBeNull()
      expect(getPluginFileTypeIconIndex(noFile, `/a/x.${name}`)).toBeNull()
    }
    expect(getPluginFileTypeIconIndex(noFile, '/a/__proto__')).toBeNull()
  })

  it('ignores non-index values', () => {
    const bad = { icons: {}, fileNames: { 'a.txt': -1 }, fileExtensions: { md: 1.5 } }
    expect(getPluginFileTypeIconIndex(bad, '/a/a.txt')).toBeNull()
    expect(getPluginFileTypeIconIndex(bad, '/a/b.md')).toBeNull()
  })
})
