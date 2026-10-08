// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import CsvViewer from './CsvViewer'

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({
    count,
    estimateSize,
    paddingStart = 0
  }: {
    count: number
    estimateSize: (index: number) => number
    paddingStart?: number
  }) => ({
    getVirtualItems: () =>
      Array.from({ length: Math.min(count, 3) }, (_, index) => ({
        index,
        key: index,
        start: paddingStart + index * estimateSize(index),
        size: estimateSize(index),
        end: paddingStart + (index + 1) * estimateSize(index)
      })),
    getTotalSize: () => paddingStart + count * estimateSize(0),
    resizeItem: vi.fn(),
    measure: vi.fn()
  })
}))

afterEach(cleanup)

async function chooseDelimiter(label: string): Promise<void> {
  fireEvent.keyDown(screen.getByRole('combobox', { name: 'Delimiter' }), { key: 'ArrowDown' })
  fireEvent.click(await screen.findByRole('option', { name: label }))
}

describe('CSV delimiter selection', () => {
  it('previews a dense file below the paged byte threshold', () => {
    const header = Array.from({ length: 100 }, (_, i) => `column-${i}`).join(',')
    const content = `${header}\n${`${Array.from({ length: 100 }, () => '1').join(',')}\n`.repeat(4000)}`
    expect(new TextEncoder().encode(content).length).toBeLessThan(1024 * 1024)
    render(<CsvViewer content={content} filePath="dense.csv" />)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('table').getAttribute('aria-rowcount')).toBe('4001')
  })
  it('lets the reader resolve ambiguous headerless decimal data', async () => {
    render(<CsvViewer content={'1,50;coffee\n2,75;tea'} filePath="prices.csv" />)
    expect(screen.getByRole('combobox', { name: 'Delimiter' }).textContent).toBe('Auto (Comma)')
    expect(screen.getByRole('columnheader', { name: '50;coffee' })).toBeTruthy()

    await chooseDelimiter('Semicolon (;)')

    expect(screen.getByRole('columnheader', { name: '1,50' })).toBeTruthy()
    expect(screen.getByRole('cell', { name: '2,75' })).toBeTruthy()
    expect(screen.getByRole('cell', { name: 'tea' })).toBeTruthy()
  })

  it('applies the selected separator to quoted multiline records', async () => {
    render(
      <CsvViewer content={'"multi\nline";value\n"first\nsecond";"a;b"'} filePath="multiline.csv" />
    )
    await chooseDelimiter('Semicolon (;)')

    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      '#',
      'multi\nline',
      'value'
    ])
    expect(screen.getAllByRole('cell').map((cell) => cell.textContent)).toEqual([
      'first\nsecond',
      'a;b'
    ])
  })

  it('allows an explicit comma separator even when the extension is tsv', async () => {
    render(<CsvViewer content={'amount,label\n"1,50",coffee'} filePath="misnamed.tsv" />)
    expect(screen.getByRole('combobox', { name: 'Delimiter' }).textContent).toBe('Auto (Tab)')

    await chooseDelimiter('Comma (,)')

    expect(screen.getByRole('columnheader', { name: 'amount' })).toBeTruthy()
    expect(screen.getByRole('cell', { name: '1,50' })).toBeTruthy()
  })

  it('keeps an explicit choice on refresh and can return to the current auto choice', async () => {
    const { rerender } = render(<CsvViewer content={'name;value\na;1'} filePath="data.csv" />)
    await chooseDelimiter('Semicolon (;)')

    rerender(<CsvViewer content={'name\tvalue\nb\t2'} filePath="data.csv" />)

    expect(screen.getByRole('combobox', { name: 'Delimiter' }).textContent).toBe('Semicolon (;)')
    expect(screen.getAllByRole('columnheader')).toHaveLength(2)
    await chooseDelimiter('Auto (Tab)')
    expect(screen.getByRole('columnheader', { name: 'value' })).toBeTruthy()
    expect(screen.getByRole('cell', { name: '2' })).toBeTruthy()
  })

  it('resets to Auto when the editor mounts a different file identity', async () => {
    const { rerender } = render(
      <CsvViewer key="first" content={'name;value\na;1'} filePath="first.csv" />
    )
    await chooseDelimiter('Comma (,)')

    rerender(<CsvViewer key="second" content={'name\tvalue\nb\t2'} filePath="second.tsv" />)

    expect(screen.getByRole('combobox', { name: 'Delimiter' }).textContent).toBe('Auto (Tab)')
    expect(screen.getByRole('columnheader', { name: 'value' })).toBeTruthy()
  })
})
