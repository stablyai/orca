// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { createElement, useLayoutEffect, useRef } from 'react'
import type { MarkdownDocument } from '../../../../shared/filesystem-entry-types'
import { useMonacoEditorDecorations } from './use-monaco-editor-decorations'
import type { editor, languages, Position } from 'monaco-editor'
import type { OnMount } from '@monaco-editor/react'
import {
  ensureMarkdownDocCompletionProvider,
  setMarkdownDocCompletionDocuments,
  clearMarkdownDocCompletionDocuments
} from './monaco-markdown-doc-completions'

afterEach(cleanup)

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
      {
        isCancellationRequested: false,
        onCancellationRequested: () => ({ dispose() {} })
      }
    )
    return result?.suggestions ?? []
  }
}

function documents(name: string) {
  return [
    {
      filePath: `/repo/${name}.md`,
      relativePath: `${name}.md`,
      basename: `${name}.md`,
      name
    }
  ]
}

describe('live Markdown completion ownership', () => {
  it('preserves every mounted model when many other scopes are supplied', async () => {
    const complete = register()
    const active = model('active')
    const owner = Symbol()
    setMarkdownDocCompletionDocuments(active, documents('Target'), owner)
    for (let scope = 0; scope < 300; scope++) {
      const other = model(`scope-${scope}`)
      setMarkdownDocCompletionDocuments(other, documents(`Target-${scope}`), Symbol())
    }
    expect((await complete(active)).map((item) => item.label)).toEqual(['Target'])
    clearMarkdownDocCompletionDocuments(active, owner)
    expect(await complete(active)).toEqual([])
  })

  it('keeps different model incarnations separate even when their URI is identical', async () => {
    const complete = register()
    const old = model('same-uri')
    const owner = Symbol()
    const current = model('same-uri')
    setMarkdownDocCompletionDocuments(old, documents('Target old'), owner)
    setMarkdownDocCompletionDocuments(current, documents('Target current'), owner)
    clearMarkdownDocCompletionDocuments(old, owner)
    expect((await complete(current)).map((item) => item.label)).toEqual(['Target current'])
  })
})

function Pane({
  textModel,
  catalog,
  language = 'markdown'
}: {
  textModel: editor.ITextModel
  catalog: MarkdownDocument[]
  language?: string
}): null {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  // Layout effects commit before the hook's passive effects read the editor.
  useLayoutEffect(() => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: completion registration only reads the editor's model in this hook fixture.
    editorRef.current = {
      getModel: () => textModel
    } as editor.IStandaloneCodeEditor
  }, [textModel])
  useMonacoEditorDecorations({
    editorRef,
    mountedEditor: null,
    content: '[[Ta',
    language,
    markdownDocuments: catalog,
    conflictDecorationsEnabled: false
  })
  return null
}

describe('pane-owned Markdown completion catalogs', () => {
  it('preserves a shared-model survivor and releases its catalog on last close', async () => {
    const complete = register()
    const shared = model('shared')
    const catalog = documents('Target')
    const first = render(createElement(Pane, { textModel: shared, catalog }))
    const second = render(createElement(Pane, { textModel: shared, catalog }))
    expect((await complete(shared)).map((item) => item.label)).toEqual(['Target'])

    first.unmount()
    expect((await complete(shared)).map((item) => item.label)).toEqual(['Target'])
    second.rerender(
      createElement(Pane, {
        textModel: shared,
        catalog: documents('Target next')
      })
    )
    expect((await complete(shared)).map((item) => item.label)).toEqual(['Target next'])
    second.unmount()
    expect(await complete(shared)).toEqual([])
  })

  it('restores surviving catalogs on language changes and isolates replacement models', async () => {
    const complete = register()
    const shared = model('same-uri')
    const replacement = model('same-uri')
    const first = render(
      createElement(Pane, {
        textModel: shared,
        catalog: documents('Target first')
      })
    )
    const catalog = documents('Target second')
    const second = render(createElement(Pane, { textModel: shared, catalog }))
    expect((await complete(shared)).map((item) => item.label)).toEqual(['Target second'])

    second.rerender(
      createElement(Pane, {
        textModel: shared,
        catalog,
        language: 'plaintext'
      })
    )
    expect((await complete(shared)).map((item) => item.label)).toEqual(['Target first'])
    second.rerender(createElement(Pane, { textModel: replacement, catalog }))
    expect((await complete(shared)).map((item) => item.label)).toEqual(['Target first'])
    expect((await complete(replacement)).map((item) => item.label)).toEqual(['Target second'])
    second.unmount()
    expect(await complete(replacement)).toEqual([])
    expect((await complete(shared)).map((item) => item.label)).toEqual(['Target first'])
    first.unmount()
    expect(await complete(shared)).toEqual([])
  })
})
