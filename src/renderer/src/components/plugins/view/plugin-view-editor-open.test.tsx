// @vitest-environment happy-dom
import { act, useEffect, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { usePluginPanelsStore } from '@/store/plugin-panels'
import {
  collectActivePluginCustomEditors,
  customEditorsForFile,
  eligibleCustomEditorsForContent,
  useCustomEditorViewStore
} from '@/store/plugin-custom-editors'
import {
  withdrawPluginEditorContent,
  withdrawPluginEditorFrame,
  reportPluginEditorContent,
  reportPluginEditorFailure,
  usePluginEditorCaptureReport
} from '@/components/editor/plugin-editor-capture-status'
import type { FileContent } from '@/components/editor/editor-panel-content-types'
import type { PluginHostListEntry } from '../../../../../shared/plugins/plugin-list-entry'
import { handlePluginViewRequest } from './plugin-view-request-handler'

const KEY = 'acme.binary'
const PATH = '/workspace/ordinary.bin'
const initialState = useAppStore.getState()
const plugin: PluginHostListEntry = {
  pluginKey: KEY,
  name: 'Binary',
  status: 'idle',
  panels: [],
  commands: [],
  customEditors: [
    {
      id: 'hex',
      title: 'Hex',
      extensions: ['.bin'],
      filenames: [],
      priority: 'default',
      contentKind: 'bytes',
      binaryFallback: true
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

let root: Root
let container: HTMLDivElement

function LoadedEditor({
  content,
  wrongFrame = false
}: {
  content: FileContent
  wrongFrame?: boolean
}) {
  const contentOwner = useRef(Symbol('content')).current
  const file = useAppStore((state) => state.openFiles.find((entry) => entry.filePath === PATH))
  const choice = useCustomEditorViewStore((state) => (file ? state.choices[file.id] : undefined))
  const progress = usePluginEditorCaptureReport(
    file?.id,
    'ready',
    null,
    `${wrongFrame ? 'acme.other/view' : 'acme.binary/hex'}:revision:0`
  )
  useEffect(() => {
    if (file) {
      const candidates = customEditorsForFile(
        file.filePath,
        collectActivePluginCustomEditors([plugin])
      )
      reportPluginEditorContent(
        file.id,
        contentOwner,
        eligibleCustomEditorsForContent(file, content, candidates).map((editor) => editor.key),
        null,
        file.filePath,
        null
      )
    }
  }, [file, content])
  useEffect(
    () => () => {
      if (file) {
        withdrawPluginEditorContent(file.id, contentOwner)
        withdrawPluginEditorFrame(file.id, contentOwner)
      }
    },
    [file?.id]
  )
  useEffect(() => {
    if (choice) {
      progress('delivered')
      if (wrongFrame && file) {
        reportPluginEditorFailure(
          file.id,
          contentOwner,
          'editor_read_failed',
          'The selected document could not be read.',
          'acme.binary/hex'
        )
      }
    }
  }, [choice, file, progress, wrongFrame])
  return null
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { plugins: { list: async () => [plugin] } }
  })
  useAppStore.setState({
    activeView: 'terminal',
    activeWorktreeId: 'wt-binary',
    openFiles: [],
    worktreesByRepo: { repo: [{ id: 'wt-binary', path: '/workspace', isArchived: false }] }
  } as never)
  usePluginPanelsStore.setState({ plugins: [plugin] })
  useCustomEditorViewStore.setState({ choices: {} })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  useAppStore.setState(initialState, true)
})

const open = () =>
  handlePluginViewRequest({
    kind: 'open-editor',
    requestId: 'r',
    pluginKey: KEY,
    editorId: 'hex',
    filePath: PATH,
    fallbackFolder: '/workspace'
  })

describe('CLI editor loaded-document acknowledgment', () => {
  it('opens a fallback editor through its ordinary extension match after delivery', async () => {
    let reply: Awaited<ReturnType<typeof open>> | undefined
    await act(async () => {
      root.render(
        <LoadedEditor
          content={{
            content: '',
            isBinary: true,
            byteSource: { target: { kind: 'local' }, filePath: PATH }
          }}
        />
      )
    })
    let pending: ReturnType<typeof open> | undefined
    await act(async () => {
      pending = open()
    })
    reply = await pending
    expect(reply).toEqual({ requestId: 'r', ok: true, editor: { id: 'hex', title: 'Hex' } })
  })

  it('rejects binary content without an authorized byte source', async () => {
    await act(async () => {
      root.render(<LoadedEditor content={{ content: '', isBinary: true }} />)
    })
    let reply: Awaited<ReturnType<typeof open>> | undefined
    let pending: ReturnType<typeof open> | undefined
    await act(async () => {
      pending = open()
    })
    reply = await pending
    expect(reply).toMatchObject({ ok: false, code: 'editor_ineligible' })
  })

  it('does not accept another editor frame’s document acknowledgment', async () => {
    await act(async () => {
      root.render(
        <LoadedEditor
          wrongFrame
          content={{
            content: '',
            isBinary: true,
            byteSource: { target: { kind: 'local' }, filePath: PATH }
          }}
        />
      )
    })
    let reply: Awaited<ReturnType<typeof open>> | undefined
    let pending: ReturnType<typeof open> | undefined
    await act(async () => {
      pending = open()
    })
    reply = await pending
    expect(reply).toMatchObject({ ok: false, code: 'editor_read_failed' })
  })
})
