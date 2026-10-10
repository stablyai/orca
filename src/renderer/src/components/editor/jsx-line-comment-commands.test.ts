// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import { createJsxLineCommentCommands } from './jsx-line-comment-commands'
import { CommandExecutor } from 'monaco-editor/esm/vs/editor/common/cursor/cursor.js'

function apply(source: string, selections: monaco.Selection[]) {
  const model = monaco.editor.createModel(source, 'plaintext')
  const run = (current: monaco.Selection[]) => {
    model.pushStackElement()
    const commands = createJsxLineCommentCommands(model, current, {
      insertSpace: true,
      ignoreEmptyLines: true
    })
    const result = commands ? CommandExecutor.executeCommands(model, current, commands) : current
    model.pushStackElement()
    return result ?? current
  }
  return { model, run, selections: run(selections) }
}

describe('native JSX line comments', () => {
  it('wraps and unwraps a whole child line with one Undo and tracked caret', async () => {
    const source = '<div>\n  <Child />\n</div>'
    const probe = apply(source, [new monaco.Selection(2, 4, 2, 4)])
    try {
      expect(probe.model.getValue()).toBe('<div>\n  {/* <Child /> */}\n</div>')
      expect(probe.selections[0].positionLineNumber).toBe(2)
      probe.run(probe.selections)
      expect(probe.model.getValue()).toBe(source)
      await probe.model.undo()
      expect(probe.model.getValue()).toContain('{/* <Child /> */}')
      await probe.model.undo()
      expect(probe.model.getValue()).toBe(source)
    } finally {
      probe.model.dispose()
    }
  })
  it('wraps two child lines and excludes a selection ending at the next line start', () => {
    const source = '<div>\n  <A />\n  <B />\n</div>'
    const probe = apply(source, [new monaco.Selection(2, 3, 4, 1)])
    try {
      expect(probe.model.getValue()).toBe('<div>\n  {/* <A />\n  <B /> */}\n</div>')
      probe.run(probe.selections)
      expect(probe.model.getValue()).toBe(source)
    } finally {
      probe.model.dispose()
    }
  })
  it('maps reverse selections and separate carets in one command batch', async () => {
    const source = '<div>\n  <A />\n  <B />\n</div>'
    const probe = apply(source, [
      new monaco.Selection(2, 8, 2, 3),
      new monaco.Selection(3, 4, 3, 4)
    ])
    try {
      expect(probe.model.getValue()).toBe('<div>\n  {/* <A /> */}\n  {/* <B /> */}\n</div>')
      expect(probe.selections[0].getDirection()).toBe(monaco.SelectionDirection.RTL)
      await probe.model.undo()
      expect(probe.model.getValue()).toBe(source)
    } finally {
      probe.model.dispose()
    }
  })
  it('does not combine separate comment pairs across two selected lines', () => {
    const source = '  {/* one */}\n  {/* two */}'
    const probe = apply(source, [new monaco.Selection(1, 3, 2, 14)])
    try {
      expect(probe.model.getValue()).toBe(source)
    } finally {
      probe.model.dispose()
    }
  })
  it('does not nest one existing middle-line comment inside a wider selection', () => {
    const source = '  <A />\n  {/* <B /> */}\n  <C />'
    const probe = apply(source, [new monaco.Selection(1, 3, 3, 8)])
    try {
      expect(probe.model.getValue()).toBe(source)
      expect(probe.model.canUndo()).toBe(false)
    } finally {
      probe.model.dispose()
    }
  })
  for (const source of ['  {/* one */} <Child />', '  {/* one */} {/* two */}']) {
    it(`preserves separate pairs and toggles a single pair in ${source}`, () => {
      const probe = apply(source, [new monaco.Selection(1, 7, 1, 10)])
      try {
        expect(probe.model.getValue()).toBe(
          source.includes('two') ? source : source.replace('{/* one */}', 'one')
        )
      } finally {
        probe.model.dispose()
      }
    })
  }
  it('leaves unmatched closing delimiters unchanged', () => {
    const source = '  text {/* one */} neighbor */}'
    const probe = apply(source, [new monaco.Selection(1, 3, 1, 7)])
    try {
      expect(probe.model.getValue()).toBe(source)
    } finally {
      probe.model.dispose()
    }
  })
  it('leaves two carets on the same child line and their selections unchanged', () => {
    const source = '<div>\n  <Child />\n</div>'
    const selections = [new monaco.Selection(2, 3, 2, 3), new monaco.Selection(2, 8, 2, 8)]
    const probe = apply(source, selections)
    try {
      expect(probe.model.getValue()).toBe(source)
      expect(probe.selections).toEqual(selections)
      expect(probe.model.canUndo()).toBe(false)
    } finally {
      probe.model.dispose()
    }
  })
})
