import { describe, expect, it } from 'vitest'
import {
  isPluginIconThemeRegistration,
  parsePluginIconThemeArtifact
} from './plugin-icon-theme-artifact'

describe('plugin icon-theme artifacts', () => {
  it('normalizes association names and returns unique asset paths', () => {
    expect(
      parsePluginIconThemeArtifact(
        JSON.stringify({
          schemaVersion: 1,
          icons: { folder: 'icons/folder.svg' },
          fileNames: { README: 'icons/readme.svg' },
          fileExtensions: { TS: 'icons/typescript.svg' },
          folderNames: { Src: 'icons/source.svg' },
          folderNamesExpanded: { SRC: 'icons/source.svg' }
        })
      )
    ).toEqual({
      ok: true,
      theme: {
        schemaVersion: 1,
        icons: { folder: 'icons/folder.svg' },
        fileNames: { readme: 'icons/readme.svg' },
        fileExtensions: { ts: 'icons/typescript.svg' },
        folderNames: { src: 'icons/source.svg' },
        folderNamesExpanded: { src: 'icons/source.svg' }
      },
      assetPaths: [
        'icons/folder.svg',
        'icons/readme.svg',
        'icons/typescript.svg',
        'icons/source.svg'
      ]
    })
  })

  it.each([
    ['non-SVG asset', { icons: { folder: 'icons/folder.png' } }],
    ['unsafe folder key', { folderNames: { '../src': 'icons/folder.svg' } }],
    ['non-portable extension', { fileExtensions: { '*.ts': 'icons/file.svg' } }],
    ['empty mappings', {}]
  ])('rejects %s', (_label, overrides) => {
    expect(
      parsePluginIconThemeArtifact(
        JSON.stringify({
          schemaVersion: 1,
          icons: {},
          fileNames: {},
          fileExtensions: {},
          folderNames: {},
          folderNamesExpanded: {},
          ...overrides
        })
      ).ok
    ).toBe(false)
  })

  it('validates the renderer wire registration and all referenced assets', () => {
    const src = 'data:image/svg+xml;base64,PHN2Zy8+' as const
    expect(
      isPluginIconThemeRegistration({
        id: 'plugin:sample.icons/colorful',
        pluginKey: 'sample.icons',
        themeId: 'colorful',
        label: 'Colorful',
        theme: {
          schemaVersion: 1,
          icons: { folder: 'icons/folder.svg' },
          fileNames: {},
          fileExtensions: {},
          folderNames: {},
          folderNamesExpanded: {}
        },
        assets: { 'icons/folder.svg': { src, monochrome: false } }
      })
    ).toBe(true)
  })

  it('accepts association names that match inherited object properties', () => {
    const result = parsePluginIconThemeArtifact(
      JSON.stringify({
        schemaVersion: 1,
        icons: {},
        fileNames: { constructor: 'icons/file.svg' }
      })
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(Object.hasOwn(result.theme.fileNames, 'constructor')).toBe(true)
      expect(result.theme.fileNames.constructor).toBe('icons/file.svg')
    }
  })
})
