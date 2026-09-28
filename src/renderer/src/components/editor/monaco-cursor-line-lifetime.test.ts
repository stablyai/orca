import { describe, expect, it, vi } from 'vitest'
import type { editor } from 'monaco-editor'
import type { OpenFile } from '@/store/slices/editor'
import { createEditorStore } from '@/store/slices/editor-slice-test-harness'
import { installMonacoViewStateTracking } from './monaco-view-state-persistence'

function makeFile(id: string, filePath: string): OpenFile {
  return {
    id,
    filePath,
    relativePath: 'file.ts',
    worktreeId: 'wt-1',
    language: 'typescript',
    mode: 'edit',
    isDirty: false
  }
}

function startTracking(
  store: ReturnType<typeof createEditorStore>,
  file: OpenFile,
  line: number
): ReturnType<typeof installMonacoViewStateTracking> {
  const mockEditor = {
    getPosition: () => ({ lineNumber: line, column: 1 }),
    onDidChangeCursorPosition: () => ({ dispose: vi.fn() }),
    onDidScrollChange: () => ({ dispose: vi.fn() })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Cursor tracking calls only the three mocked editor methods above.
  const editorInstance = mockEditor as unknown as editor.IStandaloneCodeEditor
  const params = {
    editorInstance,
    fileIdRef: { current: file.id },
    viewStateKey: file.id,
    scrollThrottleTimerRef: { current: null },
    setEditorCursorLine: store.getState().setEditorCursorLine
  }
  return installMonacoViewStateTracking(params)
}

describe('Monaco cursor-line ownership lifetime', () => {
  it('releases positions after 250 distinct owned editor tabs close', () => {
    const store = createEditorStore()
    for (let index = 0; index < 250; index += 1) {
      const file = makeFile(`editor:wt-1:local:file-${index}`, `/repo/file-${index}.ts`)
      store.setState({ openFiles: [file] })
      const tracking = startTracking(store, file, index + 1)
      tracking.cursorPositionSub.dispose()
      tracking.scrollStateSub.dispose()
      store.getState().closeFile(file.id)
    }

    expect(store.getState().openFiles).toHaveLength(0)
    expect(Object.keys(store.getState().editorCursorLine)).toHaveLength(0)
  })

  it('isolates same-path positions and closes only the selected file identity', () => {
    const store = createEditorStore()
    const local = makeFile('editor:wt-1:local:file.ts', '/repo/file.ts')
    const remote = makeFile('editor:wt-1:remote-a:file.ts', '/repo/file.ts')
    store.setState({ openFiles: [local, remote] })
    const localTracking = startTracking(store, local, 12)
    const remoteTracking = startTracking(store, remote, 35)

    expect(store.getState().editorCursorLine).toEqual({ [local.id]: 12, [remote.id]: 35 })
    localTracking.cursorPositionSub.dispose()
    localTracking.scrollStateSub.dispose()
    store.getState().closeFile(local.id)
    expect(store.getState().editorCursorLine).toEqual({ [remote.id]: 35 })
    remoteTracking.cursorPositionSub.dispose()
    remoteTracking.scrollStateSub.dispose()
    store.getState().closeFile(remote.id)
    expect(store.getState().editorCursorLine).toEqual({})
  })
})
