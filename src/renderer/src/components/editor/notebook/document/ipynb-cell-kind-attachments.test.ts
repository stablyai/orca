import { expect, it } from 'vitest'
import { updateIpynbCellKind } from './ipynb-cell-mutations'

it('keeps notebook cells valid when converting attached Markdown to code', () => {
  const cell = {
    id: 'attached-cell',
    cell_type: 'markdown',
    metadata: { tags: ['example'] },
    source: ['![example](attachment:example.png)'],
    attachments: { 'example.png': { 'image/png': 'iVBORw0KGgo=' } }
  }
  const content = JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [cell] })
  const code = JSON.parse(updateIpynbCellKind(content, 0, 'code', 'python')).cells[0]

  // nbformat only allows attachments on Markdown and raw cells, never code cells.
  expect(code).toEqual({
    id: cell.id,
    cell_type: 'code',
    metadata: { ...cell.metadata, vscode: { languageId: 'python' } },
    source: cell.source,
    outputs: [],
    execution_count: null
  })
  const raw = JSON.parse(updateIpynbCellKind(content, 0, 'raw', 'python')).cells[0]
  expect(raw.attachments).toEqual(cell.attachments)
  expect(raw.source).toEqual(cell.source)
})
