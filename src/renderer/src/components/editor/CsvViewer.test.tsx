// @vitest-environment happy-dom

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import CsvViewer from './CsvViewer'

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 28,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 28
      }))
  })
}))

afterEach(cleanup)

describe('CSV column resizing', () => {
  it('resizes a column by dragging its header boundary', () => {
    const view = render(
      <CsvViewer
        content={'Name,Description\nAda,Short\nGrace,Longer value'}
        filePath="people.csv"
      />
    )
    const header = view.getAllByRole('row')[0] as HTMLElement
    const firstDataRow = view.getAllByRole('row')[1] as HTMLElement

    expect(header.style.gridTemplateColumns).toBe('48px 80px 108px')
    expect(firstDataRow.style.gridTemplateColumns).toBe(header.style.gridTemplateColumns)

    const handles = view.getAllByRole('separator', { name: 'Resize column' })
    fireEvent.mouseDown(handles[0]!, { button: 0, clientX: 100 })
    expect(document.body.style.cursor).toBe('col-resize')
    fireEvent.mouseMove(document, { clientX: 160 })

    expect(header.style.gridTemplateColumns).toBe('48px 140px 108px')
    expect(firstDataRow.style.gridTemplateColumns).toBe(header.style.gridTemplateColumns)

    fireEvent.mouseUp(document)
    expect(document.body.style.cursor).toBe('')
  })

  it('supports keyboard resizing and clamps to the minimum width', () => {
    const view = render(<CsvViewer content={'Name\nAda'} filePath="people.csv" />)
    const header = view.getAllByRole('row')[0] as HTMLElement
    const handle = view.getByRole('separator', { name: 'Resize column' })

    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(header.style.gridTemplateColumns).toBe('48px 80px')

    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(header.style.gridTemplateColumns).toBe('48px 96px')
    expect(handle.getAttribute('aria-valuenow')).toBe('96')
  })

  it('keeps resized widths across content updates and resets them for another file', () => {
    const view = render(<CsvViewer content={'Name\nAda'} filePath="people.csv" />)
    let handle = view.getByRole('separator', { name: 'Resize column' })

    fireEvent.mouseDown(handle, { button: 0, clientX: 100 })
    fireEvent.mouseMove(document, { clientX: 160 })
    fireEvent.mouseUp(document)

    view.rerender(<CsvViewer content={'Name\nAda\nGrace'} filePath="people.csv" />)
    expect((view.getAllByRole('row')[0] as HTMLElement).style.gridTemplateColumns).toBe(
      '48px 140px'
    )

    view.rerender(<CsvViewer content={'Code\nA'} filePath="codes.csv" />)
    handle = view.getByRole('separator', { name: 'Resize column' })
    expect((view.getAllByRole('row')[0] as HTMLElement).style.gridTemplateColumns).toBe('48px 80px')
    expect(handle.getAttribute('aria-valuenow')).toBe('80')
  })
})
