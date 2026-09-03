// @vitest-environment happy-dom

import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { EventBus } from 'pdfjs-dist/web/pdf_viewer.mjs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PdfFind from './PdfFind'

vi.mock('@/i18n/i18n', () => ({
  translate: (
    _key: string,
    fallback: string,
    values?: { value0?: number; value1?: number }
  ): string =>
    fallback
      .replace('{{value0}}', String(values?.value0 ?? ''))
      .replace('{{value1}}', String(values?.value1 ?? ''))
}))

afterEach(cleanup)

type FindListener = (event: { matchesCount: { current: number; total: number } }) => void

class FindEventBus {
  private readonly listeners = new Map<string, Set<FindListener>>()

  on(name: string, listener: FindListener): void {
    const listeners = this.listeners.get(name) ?? new Set<FindListener>()
    listeners.add(listener)
    this.listeners.set(name, listeners)
  }

  off(name: string, listener: FindListener): void {
    this.listeners.get(name)?.delete(listener)
  }

  dispatch(name: string, current: number, total: number): void {
    for (const listener of this.listeners.get(name) ?? []) {
      listener({ matchesCount: { current, total } })
    }
  }
}

describe('PdfFind match counter', () => {
  it('tracks the selected match while navigating results', async () => {
    const eventBus = new FindEventBus()
    const view = render(
      <PdfFind
        isOpen
        onClose={vi.fn()}
        eventBusRef={{ current: eventBus as unknown as InstanceType<typeof EventBus> }}
      />
    )
    fireEvent.change(view.getByPlaceholderText('Find in page...'), {
      target: { value: 'needle' }
    })

    eventBus.dispatch('updatefindmatchescount', 1, 3)
    await waitFor(() => expect(view.getByText('1 of 3')).toBeTruthy())

    eventBus.dispatch('updatefindcontrolstate', 2, 3)
    await waitFor(() => expect(view.getByText('2 of 3')).toBeTruthy())
  })
})
