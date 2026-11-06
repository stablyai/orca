// @vitest-environment happy-dom

import React, { type ComponentProps } from 'react'
import type * as DndKitCore from '@dnd-kit/core'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { NativeChatQueuedMessageRows } from './NativeChatQueuedMessageRows'
import type { QueuedMessageCard } from '../../../../shared/agent-session/view/structured-agent-session-queued-cards'

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
