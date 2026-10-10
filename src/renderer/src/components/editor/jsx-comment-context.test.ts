// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import type { languages } from 'monaco-editor'
import { loadNodeOniguruma } from '@/lib/monaco-languages/textmate-oniguruma-fixture'
import { getJsxCommentContexts, loadJsxCommentTokensProvider } from './jsx-comment-context'

const models: monaco.editor.ITextModel[] = []
let provider: languages.TokensProvider | undefined
const loadProvider = async () => {
  if (!provider) {
    throw new Error('JSX grammar fixture not loaded')
  }
  return provider
}
function model(source: string) {
  const result = monaco.editor.createModel(source, 'plaintext')
  models.push(result)
  return result
}
beforeAll(async () => {
  provider = await loadJsxCommentTokensProvider(loadNodeOniguruma)
})
afterEach(() => {
  models.splice(0).forEach((current) => current.dispose())
  vi.restoreAllMocks()
})

describe('actual JSX comment contexts', () => {
  it('distinguishes root tags, child tags, attributes, expressions and nested JSX', async () => {
    const source = [
      'const view = (',
      '<section>',
      '<Child',
      '  title="value"',
      '  render={() => (',
      '    <Inner>',
      '      text',
      '    </Inner>',
      '  )}',
      '/>',
      '{items.map(item => {',
      '  const value = item.name',
      '  return <Other />',
      '})}',
      '{/* existing comment */}',
      '</section>',
      ')'
    ].join('\n')
    const current = model(source)
    expect(
      await getJsxCommentContexts(current, [2, 3, 4, 6, 7, 12, 13, 15], { loadProvider })
    ).toEqual(['script', 'jsx', 'script', 'script', 'jsx', 'script', 'script', 'jsx'])
  })
  it('reuses unchanged prefix states and invalidates them after an earlier edit', async () => {
    const current = model('const view = <div>\n<Child />\n</div>')
    const provider = await loadProvider()
    const tokenize = vi.spyOn(provider, 'tokenize')
    expect(await getJsxCommentContexts(current, [2], { loadProvider })).toEqual(['jsx'])
    tokenize.mockClear()
    expect(await getJsxCommentContexts(current, [1, 2], { loadProvider })).toEqual([
      'script',
      'jsx'
    ])
    expect(tokenize).not.toHaveBeenCalled()
    current.applyEdits([
      { range: new monaco.Range(1, 1, 1, current.getLineMaxColumn(1)), text: 'let x = 1' }
    ])
    expect(await getJsxCommentContexts(current, [2], { loadProvider })).toEqual(['script'])
    expect(tokenize).toHaveBeenCalledTimes(2)
  })
  it('declines uncertain contexts after an oversized line', async () => {
    const current = model(`const view = <div>\n${'x'.repeat(2_048)}\n<Child />\n</div>`)
    expect(await getJsxCommentContexts(current, [1, 2, 3], { loadProvider })).toEqual([
      'script',
      'unknown',
      'unknown'
    ])
  })
  it('declines a partial selection inside an existing multiline block comment', async () => {
    const current = model('const view = <div>\n  {/*\n    existing body\n  */}\n</div>')
    expect(await getJsxCommentContexts(current, [3], { loadProvider })).toEqual(['unknown'])
  })
})

describe('asynchronous context ownership', () => {
  for (const change of ['edit', 'focus', 'dispose'] as const) {
    it(`declines a ${change} while the grammar loads`, async () => {
      const current = model('const view = <div>\n<Child />\n</div>')
      let release: ((provider: languages.TokensProvider) => void) | undefined
      let active = true
      const pending = getJsxCommentContexts(current, [2], {
        isCurrent: () => active,
        loadProvider: () =>
          new Promise((resolve) => {
            release = resolve
          })
      })
      if (change === 'edit') {
        current.applyEdits([{ range: new monaco.Range(1, 1, 1, 1), text: ' ' }])
      }
      if (change === 'focus') {
        active = false
      }
      if (change === 'dispose') {
        current.dispose()
      }
      release?.(await loadProvider())
      expect(await pending).toBeNull()
    })
  }
})
