import { describe, expect, it } from 'vitest'

import type { PluginHostListEntry } from '../../../../../shared/plugins/plugin-list-entry'
import {
  collectActivePluginCustomEditors,
  customEditorsForFile
} from '@/store/plugin-custom-editors'

function plugin(
  overrides: Partial<PluginHostListEntry> & Pick<PluginHostListEntry, 'pluginKey'>
): PluginHostListEntry {
  return {
    consentFingerprint: null,
    name: overrides.pluginKey,
    version: '1.0.0',
    publisher: 'stablyai',
    status: 'idle',
    needsReconsent: false,
    isDev: false,
    official: true,
    bundled: false,
    capabilities: [],
    panels: [],
    commands: [],
    hasWorker: false,
    restarts: 0,
    customEditors: [
      { id: 'draw', title: 'Draw', extensions: ['.excalidraw'], filenames: [], priority: 'default' }
    ],
    ...overrides
  }
}

describe('custom editor routing', () => {
  it('breaks a tie between two default editors by plugin key, not list order', () => {
    const draw = (pluginKey: string) =>
      plugin({
        pluginKey,
        customEditors: [
          {
            id: 'd',
            title: pluginKey,
            extensions: ['.excalidraw'],
            filenames: [],
            priority: 'default'
          }
        ]
      })
    const editors = customEditorsForFile(
      '/repo/diagram.excalidraw',
      collectActivePluginCustomEditors([draw('zeta.draw'), draw('alpha.draw')])
    )
    expect(editors[0]?.pluginKey).toBe('alpha.draw')
  })
})

describe('binary fallback editors', () => {
  const fallback: ActivePluginCustomEditor = {
    id: 'hex',
    title: 'Hex',
    key: 'acme.binary/hex',
    pluginKey: 'acme.binary',
    pluginName: 'Binary',
    extensions: [],
    filenames: [],
    priority: 'default',
    contentKind: 'bytes',
    binaryFallback: true
  }
  const byteSource = { target: { kind: 'local' as const }, filePath: '/repo/document' }
  function routed(
    path: string,
    content: Partial<FileContent>,
    editors = [fallback],
    choice?: string
  ) {
    const activeFile = file({
      id: path,
      filePath: path,
      relativePath: path.split('/').at(-1),
      language: 'plaintext'
    })
    return model({ activeFile, editors: customEditorsForFile(path, editors), content, choice })
  }

  it('uses loaded binary classification regardless of name, never the same-name plaintext', () => {
    for (const path of ['/repo/document', '/repo/data.unknown', '/repo/.hidden']) {
      expect(routed(path, { isBinary: true, byteSource }).activeCustomEditor?.key).toBe(
        'acme.binary/hex'
      )
      expect(routed(path, { isBinary: false, byteSource }).activeCustomEditor).toBeNull()
    }
    expect(routed('/repo/document', { isBinary: true }).activeCustomEditor).toBeNull()
    expect(
      routed('/repo/document', { isBinary: true, byteSource, loadError: 'unreadable' })
        .activeCustomEditor
    ).toBeNull()
    expect(
      routed('/repo/document', { isBinary: true, byteSource }, [fallback], 'source')
        .activeCustomEditor
    ).toBeNull()
    expect(
      routed('/repo/document', { isBinary: true, byteSource }, [
        { ...fallback, priority: 'option' }
      ]).activeCustomEditor
    ).toBeNull()
  })

  it('keeps native viewers and protected files as their default surfaces', () => {
    for (const path of [
      '/repo/image.png',
      '/repo/document.pdf',
      '/repo/music.mp3',
      '/repo/movie.mp4'
    ]) {
      expect(routed(path, { isBinary: true, byteSource }).customEditors).toEqual([])
    }
    for (const path of [
      '/repo/.env',
      '/repo/.env.private',
      '/repo/identity.key',
      '/repo/package.json'
    ]) {
      const result = routed(path, { isBinary: true, byteSource })
      expect(result.activeCustomEditor).toBeNull()
      expect(result.customEditors.map((editor) => editor.key)).toEqual(['acme.binary/hex'])
    }
  })

  it('preserves ordinary match priority and explicit picks without duplicating an editor', () => {
    const ordinary = {
      ...fallback,
      key: 'acme.other/view',
      pluginKey: 'acme.other',
      id: 'view',
      extensions: ['.bin'],
      binaryFallback: false
    }
    const matched = routed('/repo/ordinary.bin', { isBinary: true, byteSource }, [
      fallback,
      ordinary
    ])
    expect(matched.activeCustomEditor?.key).toBe('acme.other/view')
    expect(matched.customEditors.map((editor) => [editor.key, editor.priority])).toEqual([
      ['acme.other/view', 'default'],
      ['acme.binary/hex', 'option']
    ])
    expect(
      routed('/repo/ordinary.bin', { isBinary: true, byteSource }, [
        fallback,
        { ...ordinary, priority: 'option' }
      ]).activeCustomEditor
    ).toBeNull()
    expect(
      routed(
        '/repo/ordinary.bin',
        { isBinary: true, byteSource },
        [fallback, ordinary],
        'acme.binary/hex'
      ).activeCustomEditor?.key
    ).toBe('acme.binary/hex')
    expect(
      routed('/repo/ordinary.bin', { isBinary: true, byteSource }, [
        { ...fallback, extensions: ['.bin'] }
      ]).customEditors.map((editor) => editor.key)
    ).toEqual(['acme.binary/hex'])
    expect(
      routed('/repo/ordinary.bin', { isBinary: true, byteSource }, [
        fallback,
        { ...ordinary, contentKind: 'text' }
      ]).activeCustomEditor?.key
    ).toBe('acme.binary/hex')
  })

  it('recomputes on rename, content type, isolation and plugin consent changes', () => {
    const normal = { ...fallback, extensions: ['.bin'], binaryFallback: false }
    expect(
      routed('/repo/ordinary.bin', { isBinary: true, byteSource }, [normal]).activeCustomEditor?.key
    ).toBe('acme.binary/hex')
    expect(
      routed('/repo/ordinary.unknown', { isBinary: true, byteSource }, [normal]).activeCustomEditor
    ).toBeNull()
    expect(
      routed('/repo/ordinary.unknown', { isBinary: true, byteSource }).activeCustomEditor?.key
    ).toBe('acme.binary/hex')
    expect(
      routed('/repo/ordinary.unknown', { isBinary: false, byteSource }).activeCustomEditor
    ).toBeNull()
    const unavailable = customEditorsForFile(
      '/repo/document',
      [{ ...fallback, frame: 'isolated' }],
      false
    )
    expect(
      model({ editors: unavailable, content: { isBinary: true, byteSource } }).activeCustomEditor
    ).toBeNull()
    expect(
      model({
        activeFile: file({ readOnly: true }),
        editors: customEditorsForFile('/repo/document', [fallback]),
        content: { isBinary: true, byteSource }
      }).activeCustomEditor?.key
    ).toBe('acme.binary/hex')
    for (const overrides of [{ status: 'disabled' as const }, { needsReconsent: true }]) {
      expect(
        collectActivePluginCustomEditors([
          plugin({ pluginKey: 'acme.binary', customEditors: [fallback], ...overrides })
        ])
      ).toEqual([])
    }
  })
})
