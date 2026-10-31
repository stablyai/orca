// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActivePluginCustomEditor } from '@/store/plugin-custom-editors'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    fallback.replace('{{value0}}', values?.value0 ?? '')
}))

vi.mock('./editor-shortcuts', () => ({
  editorShortcutMatches: (actionId: string, event: KeyboardEvent) =>
    actionId === 'editor.save' && (event.metaKey || event.ctrlKey) && event.key === 's'
}))

import PluginCustomEditorFrame from './PluginCustomEditorFrame'
import { flushEditorFrames } from './editor-pending-flush'

const FILE_ID = '/repo/diagram.excalidraw'
const READY = { orca: 1, kind: 'evt', event: 'ready', payload: { protocol: 1 } }
const textEdit = (text: string, id = 1) => ({
  orca: 1,
  kind: 'req',
  id,
  method: 'editor.applyEdit',
  params: { baseVersion: 1, content: { kind: 'text', text } }
})
const keydown = (payload: Record<string, unknown>) => ({
  orca: 1,
  kind: 'evt',
  event: 'editor.keydown',
  payload
})
const textDocument = (text: string, readOnly: boolean) => ({
  orca: 1,
  kind: 'evt',
  event: 'editor.document',
  payload: { version: 1, readOnly, content: { kind: 'text', text } }
})

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const editor: ActivePluginCustomEditor = {
  id: 'excalidraw',
  title: 'Excalidraw',
  extensions: ['.excalidraw'],
  filenames: [],
  priority: 'default',
  key: 'stablyai.excalidraw/excalidraw',
  pluginKey: 'stablyai.excalidraw',
  pluginName: 'Excalidraw'
}

let container: HTMLDivElement
let root: Root
const readCustomEditorEntry = vi.fn()

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  readCustomEditorEntry.mockReset()
  readCustomEditorEntry.mockResolvedValue({
    html: '<main>editor</main>',
    sessionToken: 't'.repeat(43)
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the frame reads only these two plugin bridge methods.
  globalThis.window.api = {
    plugins: { readCustomEditorEntry, onChanged: () => vi.fn() }
  } as unknown as Window['api']
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

async function renderFrame(props: {
  content: string
  readOnly?: boolean
  onContentChange?: (content: string) => void
  onSave?: (content: string) => Promise<boolean>
  binaryDocument?: { bytes: Uint8Array<ArrayBuffer>; fileType: string }
}) {
  const onContentChange = props.onContentChange ?? vi.fn()
  const onSave = props.onSave ?? vi.fn().mockResolvedValue(true)
  await act(async () => {
    root.render(
      <PluginCustomEditorFrame
        editor={editor}
        fileId={FILE_ID}
        content={props.content}
        readOnly={props.readOnly ?? false}
        onContentChange={onContentChange}
        onSave={onSave}
        binaryDocument={props.binaryDocument}
      />
    )
  })
  const iframe = container.querySelector('iframe')!
  const frameWindow = iframe.contentWindow!
  const posted = vi.spyOn(frameWindow, 'postMessage')
  const fromFrame = async (data: unknown) => {
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { data, source: frameWindow }))
    })
  }
  return { iframe, posted, fromFrame, onContentChange, onSave }
}

describe('PluginCustomEditorFrame', () => {
  it('sends the buffer on ready and applies edits without saving', async () => {
    const { posted, fromFrame, onContentChange, onSave } = await renderFrame({ content: 'scene' })
    await fromFrame(READY)
    expect(posted).toHaveBeenCalledWith(textDocument('scene', false), '*', [])
    await fromFrame(textEdit('scene+rect'))
    expect(onContentChange).toHaveBeenCalledWith('scene+rect')
    expect(onSave).not.toHaveBeenCalled()
  })

  it('flushes the frame before any save of the file, and keeps the tab unsaved if it never answers', async () => {
    const { posted, fromFrame } = await renderFrame({ content: 'scene' })
    await fromFrame(READY)
    const index = { editorBufferIdOf: {}, editorBufferViews: {} }
    const flushed = flushEditorFrames(index, FILE_ID)
    expect(posted).toHaveBeenLastCalledWith(
      { orca: 1, kind: 'req', id: 0, method: 'editor.flush' },
      '*',
      []
    )
    await fromFrame(textEdit('scene+late'))
    await fromFrame({ orca: 1, kind: 'res', id: 0, result: null })
    await expect(flushed).resolves.toBe(true)

    let silent: Promise<boolean> | null = null
    await act(async () => {
      silent = flushEditorFrames(index, FILE_ID)
      await silent
    })
    await expect(silent).resolves.toBe(false)
    expect(container.textContent).toContain("Couldn't save the latest changes from Excalidraw")
  })

  it('saves on a frame chord only while it rides real user input', async () => {
    const isMac = navigator.userAgent.includes('Mac')
    const chord = keydown({ key: 's', code: 'KeyS', metaKey: isMac, ctrlKey: !isMac })
    const activation = { isActive: false }
    Object.defineProperty(navigator, 'userActivation', { value: activation, configurable: true })
    try {
      const { fromFrame, onSave } = await renderFrame({ content: 'scene' })
      await fromFrame(READY)
      await fromFrame(chord)
      expect(onSave).not.toHaveBeenCalled()
      activation.isActive = true
      await fromFrame(chord)
      expect(onSave).toHaveBeenCalledWith('scene')
    } finally {
      Reflect.deleteProperty(navigator, 'userActivation')
    }
  })

  it('never saves or edits a read-only document', async () => {
    const { fromFrame, onContentChange, onSave, posted } = await renderFrame({
      content: 'scene',
      readOnly: true
    })
    await fromFrame(READY)
    expect(posted).toHaveBeenCalledWith(textDocument('scene', true), '*', [])
    await fromFrame(textEdit('tampered'))
    await fromFrame(keydown({ key: 's', code: 'KeyS', metaKey: true }))
    expect(onContentChange).not.toHaveBeenCalled()
    expect(onSave).not.toHaveBeenCalled()
  })
})
