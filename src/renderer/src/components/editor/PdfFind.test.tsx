// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render } from '@testing-library/react'
// PDF.js's legacy entry supplies the runtime polyfills for Node-based tests.
import 'pdfjs-dist/legacy/build/pdf.mjs'
import { EventBus, FindState } from 'pdfjs-dist/web/pdf_viewer.mjs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PdfFind from './PdfFind'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: { value0: number; value1: number }) =>
    fallback
      .replace('{{value0}}', String(values?.value0))
      .replace('{{value1}}', String(values?.value1))
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function setup() {
  const bus = new EventBus()
  const eventBusRef = { current: bus }
  const onClose = vi.fn()
  const view = render(<PdfFind isOpen onClose={onClose} eventBusRef={eventBusRef} />)
  const query = (value: string): void => {
    fireEvent.change(view.getByPlaceholderText('Find in page...'), { target: { value } })
  }
  const count = (current: number, total: number): void => {
    act(() =>
      bus.dispatch('updatefindmatchescount', { source: bus, matchesCount: { current, total } })
    )
  }
  const control = (current: number, total: number, state = FindState.FOUND): void => {
    act(() =>
      bus.dispatch('updatefindcontrolstate', {
        source: bus,
        state,
        previous: false,
        entireWord: false,
        rawQuery: 'needle',
        matchesCount: { current, total }
      })
    )
  }
  const open = (isOpen: boolean): void => {
    view.rerender(<PdfFind isOpen={isOpen} onClose={onClose} eventBusRef={eventBusRef} />)
  }
  return { bus, view, query, count, control, open, onClose }
}

describe('PDF find event synchronization', () => {
  it('follows progressive totals and control-state navigation, wrap, and no results', () => {
    const { view, query, count, control } = setup()
    query('needle')
    count(1, 2)
    expect(view.getByText('1 of 2')).toBeTruthy()
    count(1, 6)
    expect(view.getByText('1 of 6')).toBeTruthy()
    control(2, 6)
    expect(view.getByText('2 of 6')).toBeTruthy()
    control(6, 6, FindState.WRAPPED)
    expect(view.getByText('6 of 6')).toBeTruthy()
    query('absent')
    control(6, 6, FindState.PENDING)
    control(0, 0, FindState.NOT_FOUND)
    expect(view.getByText('No matches')).toBeTruthy()
    query('beacon')
    count(1, 2)
    expect(view.getByText('1 of 2')).toBeTruthy()
  })

  it('subscribes before a synchronous cached result on reopening', () => {
    const { bus, view, query, count, open } = setup()
    query('needle')
    count(2, 6)
    open(false)
    bus.on('find', () => {
      bus.dispatch('updatefindcontrolstate', {
        source: bus,
        state: FindState.PENDING,
        rawQuery: 'needle',
        matchesCount: { current: 2, total: 6 }
      })
    })
    open(true)
    expect(view.getByText('2 of 6')).toBeTruthy()
  })

  it('removes both listeners on close and unmount without accumulating on reopen', () => {
    const { view, open, query, control } = setup()
    const on = vi.spyOn(EventBus.prototype, 'on')
    const off = vi.spyOn(EventBus.prototype, 'off')
    open(false)
    expect(off.mock.calls.map(([name]) => name)).toEqual([
      'updatefindmatchescount',
      'updatefindcontrolstate'
    ])
    off.mockClear()
    for (let cycle = 0; cycle < 3; cycle += 1) {
      open(true)
      query('needle')
      control(3, 6)
      expect(view.getByText('3 of 6')).toBeTruthy()
      if (cycle < 2) {
        open(false)
      }
    }
    view.unmount()
    expect(on.mock.calls).toHaveLength(6)
    expect(off.mock.calls).toEqual(on.mock.calls)
  })

  it('keeps empty queries clear even if a pending scan reports late', () => {
    const { view, query, count, control } = setup()
    query('needle')
    count(2, 6)
    query('')
    count(3, 6)
    control(3, 6)
    expect(view.queryByText('3 of 6')).toBeNull()
    query('absent')
    expect(view.getByText('No matches')).toBeTruthy()
  })

  it('dispatches next and previous from buttons and Enter without changing the query', () => {
    const { view, query, onClose } = setup()
    const dispatch = vi.spyOn(EventBus.prototype, 'dispatch')
    query('needle')
    const input = view.getByPlaceholderText('Find in page...')
    fireEvent.click(view.getByTitle('Next match'))
    fireEvent.click(view.getByTitle('Previous match'))
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(dispatch.mock.calls.filter(([name]) => name === 'find')).toEqual(
      ['', 'again', 'again', 'again', 'again'].map((type, index) => [
        'find',
        {
          source: null,
          type,
          query: 'needle',
          highlightAll: true,
          caseSensitive: false,
          entireWord: false,
          findPrevious: index === 2 || index === 4
        }
      ])
    )
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })
})
