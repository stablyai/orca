import { describe, expect, it } from 'vitest'
import { parsePluginManifest } from '../manifest/plugin-manifest'
import { PLUGIN_MANIFEST_V2_SINCE } from '../manifest/plugin-schema-field-docs'
import { pluginCatalogReleaseEntry } from '../catalog/plugin-catalog-release'
import { pluginCatalogTypes } from '../catalog/plugin-catalog-types'
import { pluginContributionSummary } from './plugin-contribution-summary'
import { matchPluginFile, pluginFileMatchRank } from './plugin-file-match'
import { requiresPluginContentApproval } from '../approval/plugin-consent-fingerprint'
import { pluginUpdateAccessGrowth } from '../approval/plugin-update-access-growth'

const excalidraw = {
  id: 'excalidraw',
  title: 'Excalidraw',
  extensions: ['.excalidraw', '.excalidraw.json'],
  entry: 'editor/index.html'
}

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestVersion: 2,
    execution: 'sandboxed-ui',
    id: 'excalidraw',
    publisher: 'stablyai',
    name: 'Excalidraw',
    version: '1.0.0',
    engines: { orca: `>=${PLUGIN_MANIFEST_V2_SINCE}` },
    contributes: { customEditors: [excalidraw] },
    ...overrides
  }
}

function parsed(overrides: Record<string, unknown> = {}) {
  const result = parsePluginManifest(manifest(overrides))
  if (!result.ok) {
    throw new Error(result.error)
  }
  return result.manifest
}

describe('contributes.customEditors', () => {
  it('accepts a sandboxed-ui editor and defaults every other point', () => {
    expect(parsed().contributes.customEditors).toEqual([{ ...excalidraw, filenames: [] }])
  })

  it('accepts a bytes editor, which edits like a text one', () => {
    const spreadsheet = {
      id: 'spreadsheet',
      title: 'Spreadsheet',
      extensions: ['.xlsx'],
      entry: 'editor/index.html',
      contentKind: 'bytes'
    }
    expect(
      parsed({ contributes: { customEditors: [spreadsheet] } }).contributes.customEditors
    ).toEqual([{ ...spreadsheet, filenames: [] }])
  })

  it('accepts an optional tab icon', () => {
    const withIcon = { ...excalidraw, icon: 'images/tab.png' }
    expect(
      parsed({ contributes: { customEditors: [withIcon] } }).contributes.customEditors[0]?.icon
    ).toBe('images/tab.png')
    expect(
      parsePluginManifest(
        manifest({ contributes: { customEditors: [{ ...excalidraw, icon: '../tab.png' }] } })
      )
    ).toMatchObject({ ok: false })
  })

  it('refuses the retired readonly field', () => {
    expect(
      parsePluginManifest(
        manifest({ contributes: { customEditors: [{ ...excalidraw, readonly: true }] } })
      )
    ).toMatchObject({ ok: false })
  })

  it('refuses an unknown content kind', () => {
    expect(
      parsePluginManifest(
        manifest({ contributes: { customEditors: [{ ...excalidraw, contentKind: 'binary' }] } })
      )
    ).toMatchObject({ ok: false })
  })

  it('needs at least the sandboxed-ui profile', () => {
    const result = parsePluginManifest(manifest({ execution: 'declarative' }))
    expect(result.ok).toBe(false)
  })

  it('needs the manifest v2 engine floor', () => {
    expect(parsePluginManifest(manifest({ engines: { orca: '>=1.4.200' } }))).toMatchObject({
      ok: false
    })
  })

  it.each([
    [{ ...excalidraw, extensions: [] }],
    [{ ...excalidraw, extensions: ['excalidraw'] }],
    [{ ...excalidraw, extensions: ['.excalidraw', '.EXCALIDRAW'] }],
    [{ ...excalidraw, extensions: [], filenames: ['a/b'] }],
    [{ ...excalidraw, priority: 'always' }],
    [{ ...excalidraw, entry: '../escape.html' }],
    [{ ...excalidraw, path: 'extra' }]
  ])('refuses a malformed editor %#', (editor) => {
    expect(
      parsePluginManifest(manifest({ contributes: { customEditors: [editor] } }))
    ).toMatchObject({ ok: false })
  })

  it('refuses duplicate editor ids', () => {
    const result = parsePluginManifest(
      manifest({ contributes: { customEditors: [excalidraw, { ...excalidraw, title: 'Again' }] } })
    )
    expect(result).toEqual({
      ok: false,
      error: 'contributes.customEditors[1]: duplicate customEditors id: excalidraw'
    })
  })

  it('accepts an editor that lists only exact file names', () => {
    expect(
      parsePluginManifest(
        manifest({
          contributes: { customEditors: [{ ...excalidraw, extensions: [], filenames: ['Board'] }] }
        })
      )
    ).toMatchObject({ ok: true })
  })

  it('lists as an editor type with dotted file types, and suggests for single-extension types', () => {
    const plugin = parsed()
    expect(pluginCatalogTypes(plugin)).toEqual(['editor'])
    expect(pluginContributionSummary(plugin)).toEqual([
      { kind: 'customEditors', name: 'Excalidraw', detail: '.excalidraw, .excalidraw.json' }
    ])
    expect(
      pluginCatalogReleaseEntry(plugin, { commit: 'a'.repeat(40), contentHash: 'h' })
    ).toMatchObject({ fileTypes: ['excalidraw'], editorFileTypes: ['excalidraw'] })
  })

  it('binds approval to the editor bytes and counts a new file type as more reach', () => {
    const plugin = parsed()
    expect(requiresPluginContentApproval(plugin)).toBe(true)
    const wider = parsed({
      contributes: { customEditors: [{ ...excalidraw, extensions: ['.excalidraw', '.svg'] }] }
    })
    expect(pluginUpdateAccessGrowth(plugin, wider).contributions).toEqual(['customEditors'])
    expect(pluginUpdateAccessGrowth(plugin, plugin).contributions).toEqual([])
  })

  it('counts an editor that takes over opening or changes content kind', () => {
    const editor = (fields: Record<string, unknown>) =>
      parsed({ contributes: { customEditors: [{ ...excalidraw, ...fields }] } })
    const option = editor({ priority: 'option' })
    const growth = (next: ReturnType<typeof parsed>) =>
      pluginUpdateAccessGrowth(option, next).contributions
    expect(growth(editor({}))).toEqual(['customEditors'])
    expect(growth(editor({ priority: 'option', contentKind: 'bytes' }))).toEqual(['customEditors'])
    // Narrower reach keeps the approval.
    expect(pluginUpdateAccessGrowth(editor({}), option).contributions).toEqual([])
    expect(growth(editor({ priority: 'option', extensions: ['.excalidraw'] }))).toEqual([])
  })
})

describe('matchPluginFile', () => {
  const match = (extensions: string[], filenames: string[] = []) => ({ extensions, filenames })

  it('matches the longest extension, case-insensitively, across path styles', () => {
    const editor = match(['.excalidraw', '.excalidraw.json', '.json'])
    expect(matchPluginFile('/repo/a/Diagram.EXCALIDRAW', editor)).toEqual({
      by: 'extension',
      extension: '.excalidraw'
    })
    expect(matchPluginFile('C:\\repo\\d.excalidraw.json', editor)).toEqual({
      by: 'extension',
      extension: '.excalidraw.json'
    })
    expect(matchPluginFile('/repo/package.json', match(['.excalidraw.json']))).toBeNull()
  })

  it('never matches a bare suffix name or a directory segment', () => {
    expect(matchPluginFile('/repo/.excalidraw', match(['.excalidraw']))).toBeNull()
    expect(matchPluginFile('/repo/x.excalidraw/readme.md', match(['.excalidraw']))).toBeNull()
  })

  it('ranks an exact file name above any extension', () => {
    const byName = matchPluginFile('/repo/Gleam.TOML', match(['.toml'], ['gleam.toml']))
    expect(byName).toEqual({ by: 'filename' })
    expect(pluginFileMatchRank(byName)).toBeGreaterThan(
      pluginFileMatchRank(matchPluginFile('/repo/gleam.toml', match(['.toml'])))
    )
    expect(pluginFileMatchRank(null)).toBe(0)
  })
})

describe('contributes.newFiles', () => {
  const drawing = {
    id: 'drawing',
    title: 'New Excalidraw drawing',
    extension: '.excalidraw',
    template: 'templates/empty.excalidraw'
  }

  it('accepts a new-file type beside its editor and summarizes it for catalogs', () => {
    const result = parsed({ contributes: { customEditors: [excalidraw], newFiles: [drawing] } })
    expect(result.contributes.newFiles).toEqual([drawing])
    expect(pluginContributionSummary(result)).toContainEqual({
      kind: 'newFiles',
      name: 'New Excalidraw drawing',
      detail: '.excalidraw'
    })
    // Why unchanged: a template seeds a file; the editor that opens it carries the type.
    expect(pluginCatalogTypes(result)).toEqual(['editor'])
  })

  it('is content only, so a data plugin may carry one', () => {
    expect(
      parsed({ execution: 'data', contributes: { newFiles: [drawing] } }).contributes.newFiles
    ).toHaveLength(1)
  })

  it('refuses a bad extension, a duplicate id and unknown fields', () => {
    for (const newFiles of [
      [{ ...drawing, extension: 'excalidraw' }],
      [drawing, { ...drawing, title: 'Again' }],
      [{ ...drawing, content: '{}' }]
    ]) {
      expect(
        parsePluginManifest(manifest({ contributes: { customEditors: [excalidraw], newFiles } })),
        JSON.stringify(newFiles)
      ).toMatchObject({ ok: false })
    }
  })
})
