// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { CsvGrid } from './CsvGrid'
import type * as VirtualLibrary from '@tanstack/react-virtual'

vi.mock('@tanstack/react-virtual', async (importOriginal) => {
  const original = await importOriginal<typeof VirtualLibrary>()
  return {
    ...original,
    useVirtualizer: (options: Parameters<typeof original.useVirtualizer>[0]) =>
      original.useVirtualizer({
        ...options,
        initialRect: { width: 500, height: 300 },
        observeElementRect: (_instance, callback) => {
          callback({ width: 500, height: 300 })
          return () => {}
        },
        observeElementOffset: (instance, callback) => {
          const element = instance.scrollElement
          const onScroll = (): void =>
            callback(
              (instance.options.horizontal ? element?.scrollLeft : element?.scrollTop) ?? 0,
              false
            )
          element?.addEventListener('scroll', onScroll)
          onScroll()
          return () => element?.removeEventListener('scroll', onScroll)
        }
      })
  }
})
afterEach(cleanup)

it('returns to existing rows when a refresh shrinks the file below its selected row window', async () => {
  const grid = (rowCount: number) => (
    <CsvGrid
      header={['id']}
      rowCount={rowCount}
      columnCount={1}
      sampleRows={[]}
      getRow={(index) => [`r${index}`]}
    />
  )
  const { rerender } = render(grid(1_500_100))
  fireEvent.click(screen.getByRole('button', { name: 'Next rows' }))
  await waitFor(() => expect(screen.getByRole('cell', { name: 'r500000' })).toBeTruthy())
  rerender(grid(3))
  await waitFor(() => expect(screen.getByRole('cell', { name: 'r0' })).toBeTruthy())
  expect(screen.getAllByRole('row')).toHaveLength(4)
})

it('virtualizes both axes with the real TanStack implementation', async () => {
  const onVisibleRows = vi.fn()
  render(
    <CsvGrid
      header={Array.from({ length: 2000 }, (_, i) => `column-${i}`)}
      rowCount={200_000}
      columnCount={2000}
      sampleRows={[]}
      getRow={(index) => [String(index)]}
      onVisibleRows={onVisibleRows}
    />
  )
  const scroll = screen.getByTestId('csv-scroll')
  expect(screen.getAllByRole('columnheader').length).toBeLessThan(15)
  expect(screen.getAllByRole('row').length).toBeLessThan(40)
  expect(screen.getAllByRole('cell').length).toBeLessThan(400)
  scroll.scrollTop = 28 * 190_000
  scroll.scrollLeft = 80 * 1500
  fireEvent.scroll(scroll)
  await waitFor(() =>
    expect(Number(screen.getAllByRole('row')[1]?.getAttribute('aria-rowindex'))).toBeGreaterThan(
      180000
    )
  )
  expect(screen.queryByRole('columnheader', { name: 'column-0' })).toBeNull()
  expect(screen.getAllByRole('columnheader')[1]?.getAttribute('aria-colindex')).not.toBe('2')
  expect(screen.getAllByRole('cell').length).toBeLessThan(600)
  expect(onVisibleRows).toHaveBeenLastCalledWith(expect.any(Number), expect.any(Number))
})

it('resizes with the keyboard and aligns body columns, then resets', async () => {
  render(
    <CsvGrid
      header={['name', 'value']}
      rowCount={2}
      columnCount={2}
      sampleRows={[]}
      getRow={() => ['a', 'b']}
    />
  )
  const handle = screen.getByRole('separator', { name: 'Resize column 1' })
  fireEvent.keyDown(handle, { key: 'ArrowRight', shiftKey: true })
  await waitFor(() => expect(handle.getAttribute('aria-valuenow')).toBe('120'))
  const template = screen.getAllByRole('row')[0]?.style.gridTemplateColumns
  expect(
    screen.getAllByRole('row').every((row) => row.style.gridTemplateColumns === template)
  ).toBe(true)
  fireEvent.keyDown(handle, { key: 'Home' })
  await waitFor(() => expect(handle.getAttribute('aria-valuenow')).toBe('80'))
  for (let i = 0; i < 10; i += 1) {
    fireEvent.keyDown(handle, { key: 'ArrowLeft', shiftKey: true })
  }
  expect(handle.getAttribute('aria-valuenow')).toBe('48')
})

it('retains user widths when refreshed data changes the size estimates', async () => {
  const grid = (header: string[]) => (
    <CsvGrid
      header={header}
      rowCount={2}
      columnCount={2}
      sampleRows={[]}
      getRow={() => ['a', 'b']}
    />
  )
  const { rerender } = render(grid(['name', 'value']))
  const handle = screen.getByRole('separator', { name: 'Resize column 1' })
  fireEvent.keyDown(handle, { key: 'ArrowRight', shiftKey: true })
  rerender(grid(['a much longer header changes the width estimate', 'value']))
  await waitFor(() => expect(handle.getAttribute('aria-valuenow')).toBe('120'))
  const template = screen.getAllByRole('row')[0]?.style.gridTemplateColumns
  expect(
    screen.getAllByRole('row').every((row) => row.style.gridTemplateColumns === template)
  ).toBe(true)
  fireEvent.keyDown(handle, { key: 'Home' })
  await waitFor(() => expect(handle.getAttribute('aria-valuenow')).toBe('320'))
})

it('makes rows beyond the browser layout limit reachable', async () => {
  render(
    <CsvGrid
      header={['id']}
      rowCount={1_500_100}
      columnCount={1}
      sampleRows={[]}
      getRow={(index) => [String(index)]}
    />
  )
  const next = screen.getByRole('button', { name: 'Next rows' })
  fireEvent.click(next)
  await waitFor(() =>
    expect(screen.getAllByRole('row')[1]?.getAttribute('aria-rowindex')).toBe('500002')
  )
  fireEvent.click(next)
  fireEvent.click(next)
  expect(next.getAttribute('disabled')).not.toBeNull()
  expect(screen.getByText('Rows 1,500,001–1,500,100')).toBeTruthy()
})
