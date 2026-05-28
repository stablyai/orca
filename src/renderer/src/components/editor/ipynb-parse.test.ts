import { describe, expect, it } from 'vitest'
import {
  concatIpynbMultilineString,
  deleteIpynbCell,
  insertIpynbCell,
  moveIpynbCell,
  parseIpynb,
  translateKernelLanguageToMonaco,
  updateIpynbCellKind,
  updateIpynbCellOutputs,
  updateIpynbCellSource,
  updateIpynbCellSources
} from './ipynb-parse'

describe('ipynb parsing', () => {
  it('normalizes multiline strings like VS Code notebooks', () => {
    expect(concatIpynbMultilineString(['a', 'b\n', 'c\r\n'])).toBe('a\nb\nc\n')
  })

  it('maps Jupyter kernel language names to Monaco language ids', () => {
    expect(translateKernelLanguageToMonaco('c#')).toBe('csharp')
    expect(translateKernelLanguageToMonaco('c++11')).toBe('cpp')
    expect(translateKernelLanguageToMonaco('python')).toBe('python')
  })

  it('parses cells, metadata, and common output types', () => {
    const notebook = parseIpynb(
      JSON.stringify({
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {
          kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
          language_info: { name: 'python' }
        },
        cells: [
          {
            id: 'intro',
            cell_type: 'markdown',
            source: ['# Hello', ' notebook'],
            metadata: {}
          },
          {
            id: 'code',
            cell_type: 'code',
            execution_count: 7,
            source: ['print("hi")\n'],
            metadata: { vscode: { languageId: 'python' } },
            outputs: [
              { output_type: 'stream', name: 'stdout', text: ['hi\n'] },
              {
                output_type: 'execute_result',
                execution_count: 7,
                data: { 'text/plain': '7', 'text/html': '<b>7</b>' },
                metadata: {}
              }
            ]
          }
        ]
      })
    )

    expect(notebook.nbformat).toBe('4.5')
    expect(notebook.kernelName).toBe('Python 3')
    expect(notebook.cells).toHaveLength(2)
    expect(notebook.cells[0]).toMatchObject({
      id: 'intro',
      kind: 'markdown',
      source: '# Hello\n notebook'
    })
    expect(notebook.cells[1]).toMatchObject({
      id: 'code',
      kind: 'code',
      executionCount: 7,
      language: 'python'
    })
    expect(notebook.cells[1]?.outputs[0]).toMatchObject({ kind: 'stream', text: 'hi\n' })
    expect(notebook.cells[1]?.outputs[1]).toMatchObject({
      kind: 'display',
      items: [{ mime: 'text/html' }, { mime: 'text/plain' }]
    })
  })

  it('rejects invalid notebook roots', () => {
    expect(() => parseIpynb('[]')).toThrow('Notebook root must be a JSON object')
    expect(() => parseIpynb('{}')).toThrow('Notebook is missing a cells array')
  })

  it('serializes cell source edits while preserving notebook metadata', () => {
    const content = JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: { custom: true },
      cells: [{ cell_type: 'code', metadata: {}, execution_count: null, outputs: [], source: [] }]
    })

    const updated = JSON.parse(updateIpynbCellSource(content, 0, 'print("hi")\nprint("bye")'))
    expect(updated.metadata).toEqual({ custom: true })
    expect(updated.cells[0].source).toEqual(['print("hi")\n', 'print("bye")'])
  })

  it('serializes batched source edits with one notebook mutation', () => {
    const content = JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: { custom: true },
      cells: [
        { cell_type: 'code', metadata: {}, execution_count: null, outputs: [], source: [] },
        { cell_type: 'code', metadata: {}, execution_count: null, outputs: [], source: [] }
      ]
    })

    const updated = JSON.parse(
      updateIpynbCellSources(content, [
        { index: 0, source: 'x = 41' },
        { index: 1, source: 'print(x + 1)' }
      ])
    )
    expect(updated.metadata).toEqual({ custom: true })
    expect(updated.cells[0].source).toEqual(['x = 41'])
    expect(updated.cells[1].source).toEqual(['print(x + 1)'])
  })

  it('inserts, deletes, and changes cell kinds', () => {
    const content = JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [{ cell_type: 'markdown', metadata: {}, source: ['# Title'] }]
    })

    const inserted = JSON.parse(insertIpynbCell(content, 1, 'code', 'python'))
    expect(inserted.cells).toHaveLength(2)
    expect(inserted.cells[1]).toMatchObject({
      cell_type: 'code',
      execution_count: null,
      outputs: [],
      metadata: { vscode: { languageId: 'python' } }
    })

    const changed = JSON.parse(updateIpynbCellKind(JSON.stringify(inserted), 0, 'code', 'python'))
    expect(changed.cells[0]).toMatchObject({ cell_type: 'code', outputs: [] })

    const deleted = JSON.parse(deleteIpynbCell(JSON.stringify(changed), 1))
    expect(deleted.cells).toHaveLength(1)
  })

  it('moves cells up and down while preserving cell data', () => {
    const content = JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [
        {
          id: 'a',
          cell_type: 'code',
          metadata: {},
          execution_count: 1,
          outputs: [],
          source: ['a']
        },
        { id: 'b', cell_type: 'markdown', metadata: { keep: true }, source: ['b'] },
        { id: 'c', cell_type: 'code', metadata: {}, execution_count: 2, outputs: [], source: ['c'] }
      ]
    })

    const movedDown = JSON.parse(moveIpynbCell(content, 0, 1))
    expect(movedDown.cells.map((cell: { id: string }) => cell.id)).toEqual(['b', 'a', 'c'])
    expect(movedDown.cells[0].metadata).toEqual({ keep: true })

    const movedUp = JSON.parse(moveIpynbCell(JSON.stringify(movedDown), 2, -1))
    expect(movedUp.cells.map((cell: { id: string }) => cell.id)).toEqual(['b', 'c', 'a'])

    expect(moveIpynbCell(content, 0, -1)).toBe(content)
    expect(moveIpynbCell(content, 2, 1)).toBe(content)
  })

  it('writes Python run results as notebook outputs', () => {
    const content = JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [{ cell_type: 'code', metadata: {}, execution_count: null, outputs: [], source: [] }]
    })

    const updated = JSON.parse(
      updateIpynbCellOutputs(content, 0, {
        stdout: 'hello\n',
        stderr: '',
        exitCode: 0
      })
    )
    expect(updated.cells[0].execution_count).toBe(1)
    expect(updated.cells[0].outputs).toEqual([
      { output_type: 'stream', name: 'stdout', text: ['hello\n'] }
    ])
  })
})
