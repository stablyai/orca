// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import type { editor } from 'monaco-editor'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useMonacoContentSyncBridge } from './use-monaco-content-sync-bridge'

vi.mock('./editor-stale-mount-guard', () => ({
  mayPushTabTextIntoModel: () => true
}))

afterEach(() => {
  cleanup()
  for (const model of monaco.editor.getModels()) {
    model.dispose()
  }
})

function mountBridge(model: editor.ITextModel) {
  const onContentChange = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the bridge uses this facade's real model event, text, and undo boundary.
  const mountedEditor = {
    getModel: () => model,
    getValue: () => model.getValue(),
    onDidChangeModelContent: (listener: (event: editor.IModelContentChangedEvent) => void) =>
      model.onDidChangeContent(listener),
    saveViewState: () => null,
    restoreViewState: () => {},
    pushUndoStop: () => {
      model.pushStackElement()
      return true
    }
  } as unknown as editor.IStandaloneCodeEditor
  const editorRef: { current: editor.IStandaloneCodeEditor | null } = { current: mountedEditor }
  const bridge = renderHook(
    ({ content }) =>
      useMonacoContentSyncBridge({
        editorRef,
        mountedEditor,
        content,
        contentRef: { current: content },
        contentSyncModeRef: { current: 'undoable' },
        modelKey: model.uri.toString(),
        onContentChange
      }),
    { initialProps: { content: model.getValue() } }
  )
  return { ...bridge, onContentChange, editorRef }
}

describe('Monaco content event publication', () => {
  it('applies an external update to the real mounted model', () => {
    const model = monaco.editor.createModel('initial')
    const first = mountBridge(model)
    mountBridge(model)
    first.rerender({ content: 'external update' })
    expect(model.getValue()).toBe('external update')
  })
})
