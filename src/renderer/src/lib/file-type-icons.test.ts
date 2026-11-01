import { describe, expect, it } from 'vitest'
import { File } from 'lucide-react'
import { parsePluginIconThemeArtifact } from '../../../shared/plugins/artifacts/plugin-icon-theme-artifact'
import type { ActivePluginIconTheme } from '../store/plugin-icon-themes'
import {
  getFileTypeIcon,
  getPluginFileTypeIconIndex,
  getPluginFolderIconIndex
} from './file-type-icons'

const iconTheme = (maps: Partial<ActivePluginIconTheme>): ActivePluginIconTheme => ({
  icons: {},
  fileNames: {},
  fileExtensions: {},
  folderNames: {},
  folderNamesExpanded: {},
  ...maps
})

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
    const theme = iconTheme({ fileNames: indexes })
    expect(getPluginFileTypeIconIndex(theme, '/a/__proto__')).toBe(0)
    expect(getPluginFileTypeIconIndex(theme, '/a/CONSTRUCTOR')).toBe(1)
    expect(getPluginFileTypeIconIndex(theme, '/a/other')).toBeNull()
  })
})

describe('getPluginFileTypeIconIndex', () => {
  const theme = iconTheme({
    icons: { file: 3 },
    fileNames: { 'readme.md': 1, ['__proto__']: 4 },
    fileExtensions: { ts: 2 }
  })

  it('matches exact names, then extensions, then the file icon', () => {
    expect(getPluginFileTypeIconIndex(theme, '/a/README.md')).toBe(1)
    expect(getPluginFileTypeIconIndex(theme, '/a/x.TS')).toBe(2)
  })

  it('matches the longest dotted extension the theme maps', () => {
    const multi = iconTheme({ fileExtensions: { 'd.ts': 5, ts: 2, gz: 6 } })
    expect(getPluginFileTypeIconIndex(multi, '/a/types.d.ts')).toBe(5)
    expect(getPluginFileTypeIconIndex(multi, '/a/index.ts')).toBe(2)
    expect(getPluginFileTypeIconIndex(multi, '/a/archive.tar.gz')).toBe(6)
    expect(getPluginFileTypeIconIndex(theme, '/a/x.unknown')).toBe(3)
  })

  it('ignores inherited Object.prototype names', () => {
    const noFile = iconTheme({})
    for (const name of ['constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(getPluginFileTypeIconIndex(noFile, `/a/${name}`)).toBeNull()
      expect(getPluginFileTypeIconIndex(noFile, `/a/x.${name}`)).toBeNull()
    }
    expect(getPluginFileTypeIconIndex(noFile, '/a/__proto__')).toBeNull()
  })

  it('ignores non-index values', () => {
    const bad = iconTheme({ fileNames: { 'a.txt': -1 }, fileExtensions: { md: 1.5 } })
    expect(getPluginFileTypeIconIndex(bad, '/a/a.txt')).toBeNull()
    expect(getPluginFileTypeIconIndex(bad, '/a/b.md')).toBeNull()
  })
})

describe('getPluginFolderIconIndex', () => {
  const theme = iconTheme({
    icons: { folder: 0, 'folder-open': 1 },
    folderNames: { src: 2, docs: 4 },
    folderNamesExpanded: { src: 3 }
  })

  it('picks the name icon for the folder state, falling back to the generic slot', () => {
    expect(getPluginFolderIconIndex(theme, 'SRC', false)).toBe(2)
    expect(getPluginFolderIconIndex(theme, 'src', true)).toBe(3)
    expect(getPluginFolderIconIndex(theme, 'other', false)).toBe(0)
    expect(getPluginFolderIconIndex(theme, 'other', true)).toBe(1)
    expect(getPluginFolderIconIndex(theme, undefined, true)).toBe(1)
  })

  it('prefers the generic open icon over a collapsed name icon when open', () => {
    expect(getPluginFolderIconIndex(theme, 'docs', true)).toBe(1)
  })

  it('falls back to closed icons when the theme has no open ones', () => {
    const closedOnly = iconTheme({ icons: { folder: 0 }, folderNames: { docs: 4 } })
    expect(getPluginFolderIconIndex(closedOnly, 'docs', true)).toBe(4)
    expect(getPluginFolderIconIndex(closedOnly, 'other', true)).toBe(0)
  })

  it('matches the last segment of a compacted or Windows path', () => {
    expect(getPluginFolderIconIndex(theme, 'packages/app/src', false)).toBe(2)
    expect(getPluginFolderIconIndex(theme, String.raw`C:\repo\src`, true)).toBe(3)
  })

  it('ignores inherited Object.prototype names', () => {
    const noSlots = iconTheme({})
    expect(getPluginFolderIconIndex(noSlots, 'constructor', false)).toBeNull()
    expect(getPluginFolderIconIndex(noSlots, '__proto__', true)).toBeNull()
  })
})
