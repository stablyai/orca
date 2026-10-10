// @vitest-environment happy-dom
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest'
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import 'monaco-editor/esm/vs/editor/contrib/comment/browser/comment.js'
import { loadNodeOniguruma } from '@/lib/monaco-languages/textmate-oniguruma-fixture'
import { installMonacoJsxCommentAction } from './monaco-jsx-comment-action'
import type * as JsxCommentContextModule from './jsx-comment-context'

const contextGate = vi.hoisted(() => {
  const gate: { wait: Promise<void> | null } = { wait: null }
  return gate
})

vi.mock('./jsx-comment-context', async (importOriginal) => {
  const actual = await importOriginal<typeof JsxCommentContextModule>()
  const provider = actual.loadJsxCommentTokensProvider(loadNodeOniguruma)
  return {
    ...actual,
    getJsxCommentContexts: async (
      model: monaco.editor.ITextModel,
      lines: number[],
      options: { isCurrent: () => boolean }
    ) => {
      await contextGate.wait
      return actual.getJsxCommentContexts(model, lines, {
        ...options,
        loadProvider: () => provider
      })
    }
  }
})

const cleanups: (() => void)[] = []
afterEach(() => {
  contextGate.wait = null
  cleanups.splice(0).forEach((cleanup) => cleanup())
})
const originalCanvasContext = Object.getOwnPropertyDescriptor(
  HTMLCanvasElement.prototype,
  'getContext'
)
beforeAll(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: () => ({
      webkitBackingStorePixelRatio: 1,
      measureText: (text: string) => ({ width: text.length * 8 }),
      clearRect: () => {},
      fillRect: () => {},
      beginPath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      stroke: () => {}
    })
  })
})
afterAll(() => {
  if (originalCanvasContext) {
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', originalCanvasContext)
  }
})

function fixture(path: string, source = 'const view = <div>\n  <Child />\n</div>') {
  const container = document.createElement('div')
  document.body.append(container)
  const model = monaco.editor.createModel(source, 'plaintext')
  const instance = monaco.editor.create(container, {
    model,
    automaticLayout: false,
    minimap: { enabled: false },
    occurrencesHighlight: 'off',
    selectionHighlight: false
  })
  let relativePath = path
  const action = installMonacoJsxCommentAction(instance, () => relativePath)
  cleanups.push(() => {
    action.dispose()
    instance.dispose()
    model.dispose()
    container.remove()
  })
  instance.setSelection(new monaco.Selection(2, 3, 2, 3))
  instance.focus()
  return {
    instance,
    model,
    setPath: (next: string) => {
      relativePath = next
    },
    run: () => instance.getAction('orca.toggleJsxLineComment')?.run()
  }
}

describe('real Monaco JSX comment action', () => {
  it('uses native commands for a child caret, keeps focus and uses one Undo', async () => {
    const current = fixture('Card.tsx')
    await current.run()
    expect(current.model.getValue()).toContain('{/* <Child /> */}')
    expect(current.instance.hasTextFocus()).toBe(true)
    await current.model.undo()
    expect(current.model.getValue()).toBe('const view = <div>\n  <Child />\n</div>')
    expect(current.model.canUndo()).toBe(false)
  })
  it('does not modify a read-only editor, including direct action invocation', async () => {
    const current = fixture('Card.tsx')
    current.instance.updateOptions({ readOnly: true })
    await current.run()
    expect(current.model.getValue()).not.toContain('{/*')
    expect(current.model.canUndo()).toBe(false)
  })
  it('keeps the existing TypeScript line-comment action after a reused editor changes path', async () => {
    const configuration = monaco.languages.setLanguageConfiguration('plaintext', {
      comments: { lineComment: '//' }
    })
    cleanups.push(() => configuration.dispose())
    const current = fixture('Card.tsx')
    current.setPath('Card.ts')
    await current.run()
    expect(current.model.getValue()).toContain('// <Child />')
  })
  it('does not combine JSX and script lines or separate existing comment pairs', async () => {
    const current = fixture('Card.tsx', 'const view = <div>\n  {/* one */}\n  {/* two */}\n</div>')
    const source = current.model.getValue()
    current.instance.setSelection(new monaco.Selection(2, 3, 3, 14))
    await current.run()
    expect(current.model.getValue()).toBe(source)
    current.instance.setSelection(new monaco.Selection(1, 1, 2, 14))
    await current.run()
    expect(current.model.getValue()).toBe(source)
    expect(current.model.canUndo()).toBe(false)
  })
  for (const change of ['path', 'selection', 'focus', 'readonly', 'edit'] as const) {
    it(`does not modify a new target after ${change} changes during context loading`, async () => {
      const current = fixture('Card.tsx')
      let release: (() => void) | undefined
      contextGate.wait = new Promise((resolve) => {
        release = resolve
      })
      const pending = current.run()
      if (change === 'path') {
        current.setPath('Other.tsx')
      }
      if (change === 'selection') {
        current.instance.setPosition({ lineNumber: 1, column: 1 })
      }
      if (change === 'focus') {
        current.instance.getDomNode()?.querySelector('textarea')?.blur()
      }
      if (change === 'readonly') {
        current.instance.updateOptions({ readOnly: true })
      }
      if (change === 'edit') {
        current.model.applyEdits([{ range: new monaco.Range(2, 3, 2, 3), text: 'x' }])
      }
      const source = current.model.getValue()
      release?.()
      await pending
      expect(current.model.getValue()).toBe(source)
    })
  }
  it('does not replay simultaneous pending shortcuts against a changed target', async () => {
    const current = fixture('Card.tsx')
    let release: (() => void) | undefined
    contextGate.wait = new Promise((resolve) => {
      release = resolve
    })
    const requests = [current.run(), current.run()]
    release?.()
    await Promise.all(requests)
    expect(current.model.getValue()).toBe('const view = <div>\n  {/* <Child /> */}\n</div>')
    await current.model.undo()
    expect(current.model.canUndo()).toBe(false)
  })
})
