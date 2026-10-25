import { describe, expect, it, vi } from 'vitest'
import type { editor, languages, Position } from 'monaco-editor'
import type { OnMount } from '@monaco-editor/react'
import {
  ensureMarkdownDocCompletionProvider,
  setMarkdownDocCompletionDocuments,
  clearMarkdownDocCompletionDocuments
} from './monaco-markdown-doc-completions'

type MonacoApi = Parameters<OnMount>[1]

function model(key: string): editor.ITextModel {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Completion uses only URI and line content from this model fixture.
  return {
    uri: { toString: () => key },
    getLineContent: () => '[[Ta'
  } as unknown as editor.ITextModel
}

function register() {
  let current: languages.CompletionItemProvider | undefined
  const api = {
    languages: {
      CompletionItemKind: { File: 1 },
      registerCompletionItemProvider: vi.fn(
        (_language: string, provider: languages.CompletionItemProvider) => {
          current = provider
          return { dispose() {} }
        }
      )
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The provider registers and reads only this languages API and completion kind.
  ensureMarkdownDocCompletionProvider(api as unknown as MonacoApi)
  return async (textModel: editor.ITextModel) => {
    if (!current) {
      throw new Error('Missing provider')
    }
    const position: Position = {
      lineNumber: 1,
      column: 5,
      with: () => position,
      delta: () => position,
      equals: () => false,
      isBefore: () => false,
      isBeforeOrEqual: () => false,
      clone: () => position,
      toString: () => '(1,5)',
      toJSON: () => ({ lineNumber: 1, column: 5 })
    }
    const result = await current.provideCompletionItems(
      textModel,
      position,
      { triggerKind: 0 },
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }
    )
    return result?.suggestions ?? []
  }
}

function documents(name: string) {
  return [
    { filePath: `/repo/${name}.md`, relativePath: `${name}.md`, basename: `${name}.md`, name }
  ]
}

describe('live Markdown completion ownership', () => {
  it('preserves every mounted model when many other scopes are supplied', async () => {
    const complete = register()
    const active = model('active')
    setMarkdownDocCompletionDocuments(active, documents('Target'))
    for (let scope = 0; scope < 300; scope++) {
      setMarkdownDocCompletionDocuments(model(`scope-${scope}`), documents(`Target-${scope}`))
    }
    expect((await complete(active)).map((item) => item.label)).toEqual(['Target'])
    clearMarkdownDocCompletionDocuments(active)
    expect(await complete(active)).toEqual([])
  })

  it('keeps different model incarnations separate even when their URI is identical', async () => {
    const complete = register()
    const old = model('same-uri')
    const current = model('same-uri')
    setMarkdownDocCompletionDocuments(old, documents('Target old'))
    setMarkdownDocCompletionDocuments(current, documents('Target current'))
    clearMarkdownDocCompletionDocuments(old)
    expect((await complete(current)).map((item) => item.label)).toEqual(['Target current'])
  })
})
