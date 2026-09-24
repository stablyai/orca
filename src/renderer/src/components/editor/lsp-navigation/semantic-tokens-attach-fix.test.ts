// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import type * as Monaco from 'monaco-editor'
import { reattachActiveModelForSemanticTokens } from './semantic-tokens-attach-fix'

// S5 / spike findings §1 GATE 2 (attach): the onMount wiring must re-setModel
// on the active path so monaco's semantic-tokens contrib fetches for it.
function makeMonaco(getModel: (uri: unknown) => unknown): typeof Monaco {
  return {
    Uri: { parse: (value: string) => ({ toString: () => value }) },
    editor: { getModel }
  } as unknown as typeof Monaco
}

function makeEditor(setModel: (model: unknown) => void): Monaco.editor.IStandaloneCodeEditor {
  return { setModel } as unknown as Monaco.editor.IStandaloneCodeEditor
}

describe('reattachActiveModelForSemanticTokens — onMount attach gate', () => {
  it('re-sets the active file model so monaco fetches semantic tokens for it', () => {
    const model = { uri: 'model' }
    const setModel = vi.fn()
    const monaco = makeMonaco(() => model)

    reattachActiveModelForSemanticTokens(makeEditor(setModel), monaco, 'D:\\repo\\a.cpp')

    expect(setModel).toHaveBeenCalledTimes(1)
    expect(setModel).toHaveBeenCalledWith(model)
  })

  it('is a no-op when no model is registered for the path (non-file model)', () => {
    const setModel = vi.fn()
    const monaco = makeMonaco(() => null)

    reattachActiveModelForSemanticTokens(makeEditor(setModel), monaco, 'D:\\repo\\a.cpp')

    expect(setModel).not.toHaveBeenCalled()
  })
})
