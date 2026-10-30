import { describe, expect, it } from 'vitest'
import type { PluginHostListEntry } from '../../../preload/api-types'
import { collectActivePluginNewFiles } from './plugin-new-files'
import { collectActivePluginCustomEditors } from './plugin-custom-editors'

function plugin(overrides: Partial<PluginHostListEntry>): PluginHostListEntry {
  return {
    pluginKey: 'stablyai.orca-excalidraw',
    consentFingerprint: 'x',
    name: 'Excalidraw',
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
    ...overrides
  }
}

const drawing = { id: 'drawing', title: 'New Excalidraw drawing', extension: '.excalidraw' }
const pluginIcon = { url: 'orca-plugin-image://installed/k/dev/icon', alt: 'Excalidraw' }

describe('plugin new files and editor icons', () => {
  it('falls back to the plugin icon when a contribution declares none, and keeps its own', () => {
    const [own, inherited] = collectActivePluginNewFiles([
      plugin({
        images: { icon: pluginIcon },
        newFiles: [
          { ...drawing, icon: 'orca-plugin-image://x/new-file-0' },
          { ...drawing, id: 'b' }
        ]
      })
    ])
    expect(own).toMatchObject({
      key: 'stablyai.orca-excalidraw/drawing',
      iconUrl: 'orca-plugin-image://x/new-file-0'
    })
    expect(inherited?.iconUrl).toBe(pluginIcon.url)
    const [editor] = collectActivePluginCustomEditors([
      plugin({
        images: { icon: pluginIcon },
        customEditors: [
          {
            id: 'e',
            title: 'Excalidraw',
            extensions: ['.excalidraw'],
            filenames: [],
            priority: 'default'
          }
        ]
      })
    ])
    expect(editor?.iconUrl).toBe(pluginIcon.url)
  })

  it('offers nothing from a plugin that is off or awaiting review', () => {
    for (const status of ['disabled', 'pending', 'errored', 'invalid'] as const) {
      expect(collectActivePluginNewFiles([plugin({ status, newFiles: [drawing] })])).toEqual([])
    }
  })
})
