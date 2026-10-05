// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import type { DiffEditorProps } from '@monaco-editor/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CheckpointedDiffEditor } from './CheckpointedDiffEditor'
import {
  registerEditorModelContentCheckpoint,
  flushEditorModelContentCheckpoint
} from './editor-model-content-checkpoint'

const wrapper = vi.hoisted(() => {
  const state: { props?: DiffEditorProps } = {}
  return state
})
vi.mock('@monaco-editor/react', () => ({
  DiffEditor: (props: DiffEditorProps) => {
    wrapper.props = props
    return null
  }
}))
const cleanups: (() => void)[] = []
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanup()
  cleanups.splice(0).forEach((dispose) => dispose())
  vi.useRealTimers()
})
function fixture() {
  const model = monaco.editor.createModel('baseline', 'plaintext')
  const publish = vi.fn()
  const unregister = registerEditorModelContentCheckpoint(model, { fileId: 'diff', publish })
  cleanups.push(() => {
    unregister()
    model.dispose()
  })
  const codeEditor = {
    getModel: () => model,
    pushUndoStop: () => {
      model.pushStackElement()
      return true
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Content reconciliation only uses getModel and pushUndoStop; no widget integrations are installed in this test.
  const mounted = codeEditor as unknown as monaco.editor.IStandaloneCodeEditor
  const mount = () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This wrapper only obtains the modified editor; the parent onMount callback is absent.
    const diff = { getModifiedEditor: () => mounted } as monaco.editor.IStandaloneDiffEditor
    act(() => wrapper.props?.onMount?.(diff, monaco))
  }
  const edit = (content: string) =>
    model.applyEdits([{ range: model.getFullModelRange(), text: content }])
  return { model, publish, mount, edit }
}

describe('checkpointed diff reconciliation', () => {
  it('leaves newer model input intact when React echoes an older published checkpoint', () => {
    const f = fixture()
    const view = render(<CheckpointedDiffEditor modified="baseline" />)
    f.mount()
    act(() => {
      f.edit('checkpoint')
      flushEditorModelContentCheckpoint(f.model)
      f.edit('newer input')
    })
    view.rerender(<CheckpointedDiffEditor modified="checkpoint" />)
    expect(f.model.getValue()).toBe('newer input')
    expect(wrapper.props?.modified).toBe('baseline')
    expect(f.publish).toHaveBeenCalledExactlyOnceWith('checkpoint')
    act(() => vi.advanceTimersByTime(150))
    expect(f.publish).toHaveBeenLastCalledWith('newer input')
  })

  it('flushes a retained sibling model at mount instead of reverting to its older props', () => {
    const f = fixture()
    f.edit('pending sibling input')
    render(<CheckpointedDiffEditor modified="baseline" />)
    f.mount()
    expect(f.model.getValue()).toBe('pending sibling input')
    expect(f.publish).toHaveBeenCalledExactlyOnceWith('pending sibling input')
  })

  it('publishes pending input before an external replacement and keeps the replacement undoable', async () => {
    const f = fixture()
    const view = render(<CheckpointedDiffEditor modified="baseline" />)
    f.mount()
    act(() => f.edit('pending user input'))
    view.rerender(<CheckpointedDiffEditor modified="external replacement" />)
    expect(f.publish).toHaveBeenCalledExactlyOnceWith('pending user input')
    expect(f.model.getValue()).toBe('external replacement')
    act(() => vi.advanceTimersByTime(500))
    expect(f.publish).toHaveBeenCalledOnce()
    await act(() => f.model.undo())
    expect(f.model.getValue()).toBe('pending user input')
    act(() => vi.advanceTimersByTime(150))
    expect(f.publish).toHaveBeenLastCalledWith('pending user input')
  })
})
