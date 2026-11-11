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
  it('lets the reader resolve ambiguous headerless decimal data', async () => {
    render(<CsvViewer content={'1,50;coffee\n2,75;tea'} filePath="prices.csv" />)
    expect(screen.getByRole('combobox', { name: 'Delimiter' }).textContent).toBe('Auto (Comma)')
    expect(screen.getByRole('columnheader', { name: '50;coffee' })).toBeTruthy()

    await chooseDelimiter('Semicolon (;)')

    expect(screen.getByRole('columnheader', { name: '1,50' })).toBeTruthy()
    expect(screen.getByRole('cell', { name: '2,75' })).toBeTruthy()
    expect(screen.getByRole('cell', { name: 'tea' })).toBeTruthy()
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
})
