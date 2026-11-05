// @vitest-environment happy-dom
import { act, useEffect, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { usePluginPanelsStore } from '@/store/plugin-panels'
import { useTabCustomEditor } from '@/store/plugin-custom-editors'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import type { PluginHostListEntry } from '../../../../shared/plugins/plugin-list-entry'
import {
  reportPluginEditorContent,
  usePluginEditorCaptureReport,
  withdrawPluginEditorContent
} from './plugin-editor-capture-status'
import { attachClosedEditorTabCleanup } from './model-lifetime/retention/closed-editor-tab-controller'
import {
  pluginEditorDocumentLoaded,
  waitForPluginEditor
} from '../plugins/view/plugin-view-editor-capture'

const editor: NonNullable<PluginHostListEntry['customEditors']>[number] = {
  id: 'hex',
  title: 'Hex',
  extensions: [],
  filenames: [],
  priority: 'default',
  contentKind: 'bytes',
  binaryFallback: true
}
const plugin: PluginHostListEntry = {
  pluginKey: 'acme.binary',
  name: 'Binary',
  status: 'idle',
  customEditors: [editor],
  panels: [],
  commands: [],
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
const a: OpenFile = {
  id: 'a',
  filePath: '/workspace/a',
  relativePath: 'a',
  worktreeId: 'wt',
  language: 'plaintext',
  mode: 'edit',
  isDirty: false
}
const b: OpenFile = { ...a, id: 'b', filePath: '/workspace/b', relativePath: 'b' }
const initial = useAppStore.getState()
let root: Root
let container: HTMLDivElement
let detach: () => void

function View({ file, guest }: { file: OpenFile; guest: string }) {
  const owner = useRef(Symbol('view')).current
  const progress = usePluginEditorCaptureReport(
    file.id,
    'ready',
    guest,
    'acme.binary/hex:revision:0',
    null,
    'acme.binary/hex'
  )
  useEffect(() => {
    reportPluginEditorContent(
      file.id,
      owner,
      ['acme.binary/hex'],
      null,
      file.filePath,
      'acme.binary/hex'
    )
    return () => withdrawPluginEditorContent(file.id, owner)
  }, [file, owner])
  useEffect(() => progress('delivered'), [progress])
  return null
}

function Tab({ file }: { file: OpenFile }) {
  const selected = useTabCustomEditor(file)
  return <span data-tab={file.id}>{selected?.title ?? 'Source'}</span>
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { plugins: { list: async () => [plugin] } }
  })
  useAppStore.setState({ openFiles: [a, b] })
  usePluginPanelsStore.setState({ plugins: [plugin], fetchStatus: 'ready' })
  detach = attachClosedEditorTabCleanup(useAppStore)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  useAppStore.setState({ openFiles: [] })
  detach()
  useAppStore.setState(initial, true)
  container.remove()
})

describe('custom editor file and split lifetime', () => {
  it('keeps another split’s delivered frame and content after one split unmounts', async () => {
    await act(async () =>
      root.render(
        <>
          <View key="left" file={a} guest="left" />
          <View key="right" file={a} guest="right" />
        </>
      )
    )
    await act(async () =>
      root.render(
        <>
          <View key="left" file={a} guest="left" />
          <Tab file={a} />
        </>
      )
    )
    const acknowledged = await waitForPluginEditor(
      a.id,
      (status) => status.contentReady === true && pluginEditorDocumentLoaded(status),
      0
    )
    expect(acknowledged).toMatchObject({ met: true, status: { guestUrl: 'left' } })
  })

  it('retains an inactive file’s tab editor until that file entity closes', async () => {
    await act(async () =>
      root.render(
        <>
          <View file={a} guest="a" />
          <Tab file={a} />
        </>
      )
    )
    await act(async () =>
      root.render(
        <>
          <View file={b} guest="b" />
          <Tab file={a} />
        </>
      )
    )
    expect(container.querySelector('[data-tab="a"]')?.textContent).toBe('Hex')
    await act(async () => useAppStore.setState({ openFiles: [b] }))
    await act(async () => useAppStore.setState({ openFiles: [a, b] }))
    expect(container.querySelector('[data-tab="a"]')?.textContent).toBe('Source')
  })
})
