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
        filePath="drag.csv"
      />
    )
    const header = view.getAllByRole('row')[0] as HTMLElement
    const firstDataRow = view.getAllByRole('row')[1] as HTMLElement

    expect(header.style.gridTemplateColumns).toBe('48px 80px 108px')
    expect(firstDataRow.style.gridTemplateColumns).toBe(header.style.gridTemplateColumns)

    const handles = view.getAllByRole('separator', { name: 'Resize column Name' })
    fireEvent.pointerDown(handles[0]!, { button: 0, clientX: 100, pointerId: 1 })
    expect(document.body.style.cursor).toBe('col-resize')
    fireEvent.pointerMove(window, { clientX: 160, pointerId: 1 })

    expect(header.style.gridTemplateColumns).toBe('48px 140px 108px')
    expect(firstDataRow.style.gridTemplateColumns).toBe(header.style.gridTemplateColumns)

    fireEvent.pointerUp(window, { pointerId: 1 })
    expect(document.body.style.cursor).toBe('')
  })

  it('supports keyboard resizing and clamps to the minimum width', () => {
    const view = render(<CsvViewer content={'Name\nAda'} filePath="keyboard.csv" />)
    const header = view.getAllByRole('row')[0] as HTMLElement
    const handle = view.getByRole('separator', { name: 'Resize column Name' })

    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(header.style.gridTemplateColumns).toBe('48px 80px')

    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(header.style.gridTemplateColumns).toBe('48px 96px')
    expect(handle.getAttribute('aria-valuenow')).toBe('96')
    expect(handle.getAttribute('aria-valuemax')).toBe('10000')
  })

  it('keeps resized widths across content updates and remounts', () => {
    const view = render(<CsvViewer content={'Name\nAda'} filePath="persistent.csv" />)
    const handle = view.getByRole('separator', { name: 'Resize column Name' })

    fireEvent.pointerDown(handle, { button: 0, clientX: 100, pointerId: 2 })
    fireEvent.pointerMove(window, { clientX: 160, pointerId: 2 })
    fireEvent.pointerUp(window, { pointerId: 2 })

    view.rerender(<CsvViewer content={'Name\nAda\nGrace'} filePath="persistent.csv" />)
    expect((view.getAllByRole('row')[0] as HTMLElement).style.gridTemplateColumns).toBe(
      '48px 140px'
    )

    view.unmount()
    const reopened = render(<CsvViewer content={'Name\nAda\nGrace'} filePath="persistent.csv" />)
    expect((reopened.getAllByRole('row')[0] as HTMLElement).style.gridTemplateColumns).toBe(
      '48px 140px'
    )
  })

  it('restores cursor and selection when a drag is interrupted', () => {
    const view = render(<CsvViewer content={'Name\nAda'} filePath="cancel.csv" />)
    const handle = view.getByRole('separator', { name: 'Resize column Name' })

    fireEvent.pointerDown(handle, { button: 0, clientX: 100, pointerId: 3 })
    expect(document.body.style.userSelect).toBe('none')

    fireEvent.blur(window)
    expect(document.body.style.cursor).toBe('')
    expect(document.body.style.userSelect).toBe('')
  })
})
