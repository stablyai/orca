import { afterEach, describe, expect, it, vi } from 'vitest'
import { updateIpynbCellRun, updateIpynbCellSource } from './ipynb-cell-mutations'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ipynb parsing', () => {
  it('serializes newline-heavy cell sources without regex match or split helpers', () => {
    const content = JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [{ cell_type: 'code', metadata: {}, execution_count: null, outputs: [], source: [] }]
    })
    const split = vi.spyOn(String.prototype, 'split')
    const match = vi.spyOn(String.prototype, 'match')
    const source = `${'print(1)\n'.repeat(5000)}last`

    const updated = JSON.parse(updateIpynbCellSource(content, 0, source))

    expect(updated.cells[0].source).toHaveLength(5001)
    expect(updated.cells[0].source[0]).toBe('print(1)\n')
    expect(updated.cells[0].source.at(-1)).toBe('last')
    expect(split).not.toHaveBeenCalled()
    expect(match).not.toHaveBeenCalled()
  })

  it('serializes newline-heavy stream output without regex match or split helpers', () => {
    const content = JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [{ cell_type: 'code', metadata: {}, execution_count: null, outputs: [], source: [] }]
    })
    const split = vi.spyOn(String.prototype, 'split')
    const match = vi.spyOn(String.prototype, 'match')

    const updated = JSON.parse(
      updateIpynbCellRun(
        content,
        0,
        [{ output_type: 'stream', name: 'stdout', text: `${'line\n'.repeat(5000)}tail` }],
        1
      )
    )

    expect(updated.cells[0].outputs[0].text).toHaveLength(5001)
    expect(updated.cells[0].outputs[0].text.at(-1)).toBe('tail')
    expect(split).not.toHaveBeenCalled()
    expect(match).not.toHaveBeenCalled()
  })
})
