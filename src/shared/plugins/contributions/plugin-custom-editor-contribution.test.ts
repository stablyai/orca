import { describe, expect, it } from 'vitest'
import { parsePluginManifest } from '../manifest/plugin-manifest'
import { PLUGIN_MANIFEST_V2_SINCE } from '../manifest/plugin-schema-field-docs'
import { matchPluginFile } from './plugin-file-match'
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
})
