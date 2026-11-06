// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { usePluginPanelsStore } from '@/store/plugin-panels'
import { usePluginFrameIsolationStore } from '@/store/plugin-frame-isolation'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import type { PluginHostListEntry } from '../../../../shared/plugins/plugin-list-entry'
import { PluginEditorSourceFallbackNotice } from './PluginEditorNeedsDesktopNotice'

let root: Root
let container: HTMLDivElement
const plugin: PluginHostListEntry = {
  pluginKey: 'acme.binary',
  name: 'Binary',
  status: 'idle',
  panels: [],
  commands: [],
  customEditors: [
    {
      id: 'hex',
      title: 'Hex',
      extensions: [],
      filenames: [],
      priority: 'default',
      contentKind: 'bytes',
      binaryFallback: true,
      frame: 'isolated'
    }
  ],
  consentFingerprint: null,
  version: '1.0.0',
  publisher: 'acme',
  needsReconsent: false,
  isDev: false,
  official: false,
  bundled: false,
  capabilities: [],
  hasWorker: false,
  restarts: 0
}
const file: OpenFile = {
  id: 'file',
  filePath: '/workspace/document',
  relativePath: 'document',
  worktreeId: 'wt',
  language: 'plaintext',
  mode: 'edit',
  isDirty: false
}
const byteSource = { target: { kind: 'local' as const }, filePath: file.filePath }

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { plugins: { list: async () => [plugin] } }
  })
  usePluginPanelsStore.setState({ plugins: [plugin], fetchStatus: 'ready' })
  usePluginFrameIsolationStore.setState({ isolated: false, learnedUnder: undefined })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  usePluginFrameIsolationStore.setState({ isolated: null })
  container.remove()
})

it('shows unavailable-frame status only for an eligible binary fallback document', async () => {
  await act(async () =>
    root.render(
      <PluginEditorSourceFallbackNotice
        file={file}
        fileContent={{ content: '', isBinary: true, byteSource }}
      />
    )
  )
  expect(container.querySelector('[role="status"]')).not.toBeNull()
  for (const [path, binary] of [
    ['/workspace/main.cpp', false],
    ['/workspace/image.png', true],
    ['/workspace/document.pdf', true]
  ] as const) {
    await act(async () =>
      root.render(
        <PluginEditorSourceFallbackNotice
          file={{ ...file, filePath: path }}
          fileContent={{ content: 'source', isBinary: binary, byteSource }}
        />
      )
    )
    expect(container.querySelector('[role="status"]')).toBeNull()
  }
})
