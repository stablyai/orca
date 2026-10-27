// @vitest-environment happy-dom

import React, { type ComponentProps } from 'react'
import type * as DndKitCore from '@dnd-kit/core'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { NativeChatQueuedMessageRows } from './NativeChatQueuedMessageRows'
import type { QueuedMessageCard } from './structured-agent-session-queued-cards'

const completion = vi.hoisted(() => ({ deferred: false }))
vi.mock('@dnd-kit/core', async (importOriginal) => {
  const actual = await importOriginal<typeof DndKitCore>()
  return {
    ...actual,
    DndContext: (props: ComponentProps<typeof actual.DndContext>) => (
      <actual.DndContext
        {...props}
        onDragEnd={(event) => {
          // Stress delayed delivery while retaining the real sensor and collision calculation.
          if (completion.deferred) {
            queueMicrotask(() => props.onDragEnd?.(event))
          } else {
            props.onDragEnd?.(event)
          }
        }}
      />
    )
  }
})

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/components/ui/button', () => ({
  Button: React.forwardRef<
    HTMLButtonElement,
    ComponentProps<'button'> & { variant?: string; size?: string }
  >(({ variant: _variant, size: _size, ...props }, ref) => <button ref={ref} {...props} />)
}))
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: React.PropsWithChildren) => children,
  TooltipTrigger: ({ children }: React.PropsWithChildren) => children,
  TooltipContent: () => null
}))

it('gives mixed unsettled senders grips and neighbors while excluding sending placeholders and old hosts', () => {
  const cards: QueuedMessageCard[] = ['a', 'sending', 'mail'].map((messageId, position) => ({
    messageId,
    position,
    text: messageId,
    state: messageId === 'mail' ? 'returned' : 'waiting',
    hold: messageId === 'sending' ? 'sending' : 'queue-paused',
    ...(messageId === 'mail'
      ? { from: { kind: 'agent' as const, senders: [], orchestration: null } }
      : {})
  }))
  const move = vi.fn(async () => {})
  const renderCard: ComponentProps<typeof NativeChatQueuedMessageRows>['renderCard'] = (
    card,
    drag
  ) => (
    <li key={card.messageId} ref={drag?.rowRef}>
      {card.text}
      {drag?.grip}
    </li>
  )
  const mounted = render(
    <ul>
      <NativeChatQueuedMessageRows
        cards={cards}
        reorder={{ scope: 'contract', pending: false, move }}
        renderCard={renderCard}
      />
    </ul>
  )
  const rows = mounted.container.querySelectorAll('li')
  expect(rows[0]!.querySelector('button')).not.toBeNull()
  expect(rows[1]!.querySelector('button')).toBeNull()
  const mailGrip = rows[2]!.querySelector('button')!
  expect(mailGrip).not.toBeNull()
  fireEvent.keyDown(mailGrip, { key: 'ArrowUp' })
  expect(move).toHaveBeenCalledExactlyOnceWith('mail', { beforeMessageId: 'a' })
  mounted.rerender(
    <ul>
      <NativeChatQueuedMessageRows cards={cards} renderCard={renderCard} />
    </ul>
  )
  expect(mounted.container.querySelectorAll('li')).toHaveLength(3)
  expect(mounted.container.querySelectorAll('button')).toHaveLength(0)
  mounted.unmount()
})

it('keeps actual sortable metadata stable across unchanged visible and collapsed publications at N and 10N', () => {
  for (const count of [100, 1000]) {
    const originalIndexOf = Array.prototype.indexOf
    const originalSlice = Array.prototype.slice
    let scans = 0
    let copies = 0
    const tracked = (values: unknown[]): boolean =>
      values.length === count &&
      typeof values[0] === 'string' &&
      values[0].startsWith('sortable-contract-')
    const indexOf = vi.spyOn(Array.prototype, 'indexOf').mockImplementation(function (
      this: unknown[],
      search: unknown,
      from?: number
    ) {
      const index = originalIndexOf.call(this, search, from)
      if (tracked(this)) {
        scans += index < 0 ? this.length : index + 1
      }
      return index
    })
    const slice = vi.spyOn(Array.prototype, 'slice').mockImplementation(function (
      this: unknown[],
      start?: number,
      end?: number
    ) {
      const result = originalSlice.call(this, start, end)
      if (tracked(this)) {
        copies += result.length
      }
      return result
    })
    try {
      const cards: QueuedMessageCard[] = Array.from({ length: count }, (_, position) => ({
        messageId: `sortable-contract-${position}`,
        position,
        text: 'queued',
        state: 'waiting',
        hold: 'queue-paused',
        ...(position === count - 1
          ? { from: { kind: 'agent' as const, senders: [], orchestration: null } }
          : {})
      }))
      const move = vi.fn(async () => {})
      const action = vi.fn()
      const reorder = { scope: 'contract', pending: false, move }
      const row: ComponentProps<typeof NativeChatQueuedMessageRows>['renderCard'] = (
        card,
        drag
      ) => (
        <li
          key={card.messageId}
          ref={drag?.rowRef}
          style={drag?.rowStyle}
          onClick={() => action(card.text)}
        >
          {card.text}
          {drag?.grip}
        </li>
      )
      const mounted = render(
        <ul>
          <NativeChatQueuedMessageRows cards={cards} reorder={reorder} renderCard={row} />
        </ul>
      )
      // The real installed library's cold suffix construction is the instrumentation control.
      expect(mounted.container.querySelectorAll('button')).toHaveLength(count)
      expect(copies).toBeGreaterThanOrEqual((count * (count + 1)) / 2)
      scans = copies = 0
      mounted.rerender(
        <ul>
          <NativeChatQueuedMessageRows cards={cards} reorder={reorder} renderCard={row} />
        </ul>
      )
      expect({ scans, copies }).toEqual({ scans: 0, copies: 0 })
      mounted.rerender(
        <ul hidden>
          <NativeChatQueuedMessageRows
            cards={cards}
            reorder={{ ...reorder }}
            renderCard={(card, drag) => row({ ...card, text: 'latest' }, drag)}
          />
        </ul>
      )
      expect({ scans, copies }).toEqual({ scans: 0, copies: 0 })
      expect(mounted.container.querySelector('li')?.textContent).toBe('latest')
      const latestRow = mounted.container.querySelector('li')
      if (!latestRow) {
        throw new Error('missing queued row')
      }
      fireEvent.click(latestRow)
      expect(action).toHaveBeenLastCalledWith('latest')
      const changed = cards.map((card) => ({ ...card, text: 'changed' }))
      mounted.rerender(
        <ul hidden>
          <NativeChatQueuedMessageRows cards={changed} reorder={reorder} renderCard={row} />
        </ul>
      )
      expect(copies).toBe(0)
      expect(mounted.container.querySelector('li')?.textContent).toBe('changed')
      const reversed = changed.toReversed()
      mounted.rerender(
        <ul>
          <NativeChatQueuedMessageRows cards={reversed} reorder={reorder} renderCard={row} />
        </ul>
      )
      const grip = mounted.container.querySelector('button')
      expect(grip).not.toBeNull()
      if (!grip) {
        throw new Error('missing reorder grip')
      }
      const instruction = document.getElementById(grip.getAttribute('aria-describedby')!)
      expect(instruction?.textContent).toBe('Drag to reorder, or use the Up and Down arrow keys.')
      grip.focus()
      expect(document.activeElement).toBe(grip)
      fireEvent.keyDown(grip, { key: ' ', code: 'Space' })
      expect(move).not.toHaveBeenCalled()
      fireEvent.keyDown(grip, { key: 'ArrowDown' })
      expect(move).toHaveBeenLastCalledWith(reversed[0].messageId, {
        afterMessageId: reversed[1].messageId
      })
      const latestMove = vi.fn(async () => {})
      mounted.rerender(
        <ul>
          <NativeChatQueuedMessageRows
            cards={reversed}
            reorder={{ ...reorder, move: latestMove }}
            renderCard={row}
          />
        </ul>
      )
      fireEvent.keyDown(grip, { key: 'ArrowDown' })
      expect(latestMove).toHaveBeenLastCalledWith(reversed[0].messageId, {
        afterMessageId: reversed[1].messageId
      })
      mounted.rerender(
        <ul>
          <NativeChatQueuedMessageRows
            cards={reversed}
            reorder={{ ...reorder, pending: true }}
            renderCard={row}
          />
        </ul>
      )
      expect(mounted.container.querySelector('button')).toBe(grip)
      expect(document.activeElement).toBe(grip)
      expect(grip.getAttribute('aria-disabled')).toBe('true')
      fireEvent.keyDown(grip, { key: 'ArrowDown' })
      expect(move).toHaveBeenCalledTimes(1)
      expect(latestMove).toHaveBeenCalledTimes(1)
      const extra = { ...reversed[0], messageId: 'new-member' }
      mounted.rerender(
        <ul>
          <NativeChatQueuedMessageRows
            cards={[extra, ...reversed]}
            reorder={reorder}
            renderCard={row}
          />
        </ul>
      )
      expect(mounted.container.querySelectorAll('li')).toHaveLength(count + 1)
      const newGrip = mounted.container.querySelector('button')
      if (!newGrip) {
        throw new Error('missing new member grip')
      }
      fireEvent.keyDown(newGrip, { key: 'ArrowDown' })
      expect(move).toHaveBeenLastCalledWith(extra.messageId, {
        afterMessageId: reversed[0].messageId
      })
      mounted.unmount()
    } finally {
      indexOf.mockRestore()
      slice.mockRestore()
      cleanup()
    }
  }
})

it('only lets a live sortable owner commit pointer completion, including deferred delivery and StrictMode', async () => {
  const rectSpy = vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockImplementation(function (this: HTMLElement) {
      const index = Number(this.closest('li')?.dataset.index ?? 0)
      return new DOMRect(0, index * 40, 200, 40)
    })
  try {
    for (const scenario of [
      'valid-latest',
      'scope-before-up',
      'membership-before-up',
      'unmount-before-up',
      'scope-during-completion',
      'membership-during-completion',
      'unmount-during-completion',
      'strict-current'
    ]) {
      completion.deferred = scenario.endsWith('during-completion')
      let cards: QueuedMessageCard[] = Array.from({ length: 3 }, (_, position) => ({
        messageId: `drag-${position}`,
        position,
        text: `row-${position}`,
        state: 'waiting',
        hold: 'queue-paused',
        ...(position === 0
          ? { from: { kind: 'agent' as const, senders: [], orchestration: null } }
          : {})
      }))
      const oldMove = vi.fn(async () => {})
      const latestMove = vi.fn(async () => {})
      let scope = 'scope-a'
      let move = oldMove
      const tree = () => {
        const rows = (
          <ul>
            <NativeChatQueuedMessageRows
              cards={cards}
              reorder={{ scope, pending: false, move }}
              renderCard={(card, drag) => (
                <li
                  key={card.messageId}
                  data-index={card.position}
                  ref={drag?.rowRef}
                  style={drag?.rowStyle}
                  data-insertion={drag?.insertion}
                >
                  {card.text}
                  {drag?.grip}
                </li>
              )}
            />
          </ul>
        )
        return scenario === 'strict-current' ? <React.StrictMode>{rows}</React.StrictMode> : rows
      }
      const view = render(tree())
      const grip = view.container.querySelector('li button')
      if (!grip) {
        throw new Error('missing reorder grip')
      }
      fireEvent.pointerDown(grip, {
        pointerId: 1,
        isPrimary: true,
        button: 0,
        clientX: 10,
        clientY: 10
      })
      fireEvent.pointerMove(document, { pointerId: 1, isPrimary: true, clientX: 10, clientY: 20 })
      await waitFor(() => expect(grip.getAttribute('aria-pressed')).toBe('true'))
      fireEvent.pointerMove(document, { pointerId: 1, isPrimary: true, clientX: 10, clientY: 60 })
      await waitFor(() =>
        expect(view.container.querySelector('[data-insertion="after"]')).not.toBeNull()
      )
      const finish = () =>
        fireEvent.pointerUp(document, {
          pointerId: 1,
          isPrimary: true,
          button: 0,
          clientX: 10,
          clientY: 60
        })
      const invalidate = () => {
        if (scenario.startsWith('unmount')) {
          view.unmount()
        } else {
          if (scenario.startsWith('scope')) {
            scope = 'scope-b'
          } else {
            cards = cards.filter((card) => card.messageId !== 'drag-1')
          }
          view.rerender(tree())
        }
      }
      const valid = scenario === 'valid-latest' || scenario === 'strict-current'
      if (valid) {
        move = latestMove
        view.rerender(tree())
        finish()
      } else if (scenario.endsWith('before-up')) {
        invalidate()
        finish()
      } else {
        act(() => {
          finish()
          invalidate()
        })
      }
      await act(async () => {})
      expect(oldMove, scenario).not.toHaveBeenCalled()
      if (valid) {
        expect(latestMove, scenario).toHaveBeenCalledExactlyOnceWith('drag-0', {
          afterMessageId: 'drag-1'
        })
      } else {
        expect(latestMove, scenario).not.toHaveBeenCalled()
      }
      cleanup()
    }
  } finally {
    completion.deferred = false
    cleanup()
    rectSpy.mockRestore()
  }
})
