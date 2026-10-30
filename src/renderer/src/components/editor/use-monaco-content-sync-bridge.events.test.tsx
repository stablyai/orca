// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import type { editor } from 'monaco-editor'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useMonacoContentSyncBridge } from './use-monaco-content-sync-bridge'
import {
  beginProgrammaticContentSync,
  endProgrammaticContentSync
} from './monaco-programmatic-sync'

vi.mock('./editor-stale-mount-guard', () => ({ mayPushTabTextIntoModel: () => true }))

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
  it('does not publish programmatic echoes, while later user edits reach both panes', () => {
    const model = monaco.editor.createModel('initial')
    const first = mountBridge(model)
    const sibling = mountBridge(model)
    first.rerender({ content: 'external update' })
    expect(model.getValue()).toBe('external update')

    const key = model.uri.toString()
    beginProgrammaticContentSync(key)
    try {
      act(() => model.setValue('another owner update'))
    } finally {
      endProgrammaticContentSync(key)
    }
    expect(first.onContentChange).not.toHaveBeenCalled()
    expect(sibling.onContentChange).not.toHaveBeenCalled()

    act(() => model.setValue('user edit'))
    expect(first.onContentChange).toHaveBeenCalledExactlyOnceWith('user edit')
    expect(sibling.onContentChange).toHaveBeenCalledExactlyOnceWith('user edit')
  })

  it('does not publish from an editor that no longer owns the mounted ref', () => {
    const model = monaco.editor.createModel('initial')
    const bridge = mountBridge(model)
    bridge.editorRef.current = null
    act(() => model.setValue('retired editor'))
    expect(bridge.onContentChange).not.toHaveBeenCalled()
  })

  it('does not publish after unmount', () => {
    const model = monaco.editor.createModel('initial')
    const bridge = mountBridge(model)
    bridge.unmount()
    act(() => model.setValue('after close'))
    expect(bridge.onContentChange).not.toHaveBeenCalled()
  })
})
