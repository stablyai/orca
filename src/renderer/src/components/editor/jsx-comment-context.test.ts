// @vitest-environment happy-dom

import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import * as monaco from 'monaco-editor'
import { afterEach, describe, expect, it } from 'vitest'
import { createOnigScanner, createOnigString, loadWASM } from 'vscode-oniguruma'
import type { IOnigLib } from 'vscode-textmate'
import {
  createJsxCommentContextClassifier,
  createJsxCommentTokensProvider
} from './jsx-comment-context'

const require = createRequire(import.meta.url)
const models: monaco.editor.ITextModel[] = []
let onigurumaPromise: Promise<IOnigLib> | undefined

function loadNodeOniguruma(): Promise<IOnigLib> {
  onigurumaPromise ??= (async () => {
    const wasmPath = require.resolve('vscode-oniguruma/release/onig.wasm')
    const wasmBytes = await readFile(wasmPath)
    await loadWASM(
      wasmBytes.buffer.slice(wasmBytes.byteOffset, wasmBytes.byteOffset + wasmBytes.byteLength)
    )
    return { createOnigScanner, createOnigString }
  })()
  return onigurumaPromise
}

function createModel(source: string): monaco.editor.ITextModel {
  const model = monaco.editor.createModel(source, 'plaintext')
  models.push(model)
  return model
}

afterEach(() => {
  for (const model of models.splice(0)) {
    model.dispose()
  }
})

describe('JSX comment context', () => {
  it.each([
    { filePath: '/repo/card.js' },
    { filePath: '/repo/card.ts' },
    { filePath: '/repo/query.sql' }
  ])('does not create a classifier for $filePath', ({ filePath }) => {
    const model = createModel('const value = 1')
    expect(createJsxCommentContextClassifier(model, filePath)).toBeNull()
  })

  it.each([
    { filePath: '/repo/Card.jsx', fileKind: 'jsx' as const },
    { filePath: 'C:\\repo\\Card.TSX', fileKind: 'tsx' as const }
  ])('classifies JSX children separately in $filePath', async ({ filePath, fileKind }) => {
    const source = [
      'const view = (',
      '  <section>',
      '    <h1>Hello</h1>',
      '    Hello',
      '    {items.map((item) => {',
      '      const label = item.name',
      '      return <span>{label}</span>',
      '    })}',
      '  </section>',
      ')'
    ].join('\n')
    const model = createModel(source)
    const provider = createJsxCommentTokensProvider(fileKind, loadNodeOniguruma)
    const classifier = createJsxCommentContextClassifier(model, filePath, () => provider)
    if (!classifier) {
      throw new Error('Expected a JSX context classifier')
    }

    await expect(classifier.getContexts([1, 3, 4, 6, 7, 9])).resolves.toEqual([
      'script',
      'jsx',
      'jsx',
      'script',
      'script',
      'jsx'
    ])
    classifier.dispose()
  })

  it('classifies fragment children, attributes, and incomplete JSX without a valid AST', async () => {
    const source = [
      'const view = (',
      '  <>',
      '    <Card',
      '      title={name}',
      '    />',
      '    Hello',
      '  </>'
    ].join('\n')
    const model = createModel(source)
    const provider = createJsxCommentTokensProvider('tsx', loadNodeOniguruma)
    const classifier = createJsxCommentContextClassifier(model, '/repo/Card.tsx', () => provider)
    if (!classifier) {
      throw new Error('Expected a JSX context classifier')
    }

    await expect(classifier.getContexts([1, 2, 4, 6, 7])).resolves.toEqual([
      'script',
      'script',
      'script',
      'jsx',
      'jsx'
    ])
    classifier.dispose()
  })

  it('initializes one cache for concurrent context requests', async () => {
    const model = createModel('const value = 1\nconst other = 2')
    const provider = createJsxCommentTokensProvider('tsx', loadNodeOniguruma)
    let providerLoads = 0
    const classifier = createJsxCommentContextClassifier(model, '/repo/Card.tsx', () => {
      providerLoads += 1
      return provider
    })
    if (!classifier) {
      throw new Error('Expected a JSX context classifier')
    }

    await Promise.all([classifier.getContexts([1]), classifier.getContexts([2])])

    expect(providerLoads).toBe(1)
    classifier.dispose()
  })

  it('invalidates cached grammar state after a model edit', async () => {
    const model = createModel('const value = 1\nconst other = 2')
    const provider = createJsxCommentTokensProvider('tsx', loadNodeOniguruma)
    const classifier = createJsxCommentContextClassifier(model, '/repo/Card.tsx', () => provider)
    if (!classifier) {
      throw new Error('Expected a JSX context classifier')
    }
    await expect(classifier.getContexts([2])).resolves.toEqual(['script'])

    model.setValue('const view = (\n  <section>\n    Hello\n  </section>\n)')

    await expect(classifier.getContexts([3])).resolves.toEqual(['jsx'])
    classifier.dispose()
  })

  it('returns unknown at and after a line outside the safe context budget', async () => {
    const model = createModel(`${'x'.repeat(2_048)}\n<div />`)
    const provider = createJsxCommentTokensProvider('tsx', loadNodeOniguruma)
    const classifier = createJsxCommentContextClassifier(model, '/repo/Card.tsx', () => provider)
    if (!classifier) {
      throw new Error('Expected a JSX context classifier')
    }

    await expect(classifier.getContexts([1, 2])).resolves.toEqual(['unknown', 'unknown'])
    classifier.dispose()
  })
})
