import { describe, expect, it } from 'vitest'
import { parsePluginIconThemeArtifact } from '../../../shared/plugins/artifacts/plugin-icon-theme-artifact'
import type { ActivePluginIconTheme } from '../store/plugin-icon-themes'
import { getPluginFileTypeIconIndex } from './file-type-icons'

const iconTheme = (maps: Partial<ActivePluginIconTheme>): ActivePluginIconTheme => ({
  icons: {},
  fileNames: {},
  fileExtensions: {},
  folderNames: {},
  folderNamesExpanded: {},
  ...maps
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
