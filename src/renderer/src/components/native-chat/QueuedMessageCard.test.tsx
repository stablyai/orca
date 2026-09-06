/* @vitest-environment happy-dom */

import { DndContext } from '@dnd-kit/core'
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { QueuedMessageCard } from './QueuedMessageCard'
import { QueuedMessagePresence, useStableQueuedMessageIds } from './QueuedMessageList'
import { RoomQueuedMessageCard } from '../rooms/RoomQueuedMessageCard'
import {
  RoomQueueSquare,
  RoomQueueSquareGrid,
  RoomQueueSquareOverlay,
  RoomQueueSquareTargets
} from '../rooms/RoomQueueSquare'
import type { RoomData } from '../rooms/use-room-data'
import type { RoomParticipant } from '../../../../shared/rooms'

const mocks = vi.hoisted(() => ({
  readRoomAttachmentPreview: vi.fn(),
  useSortable: vi.fn((_options: unknown) => ({
    setNodeRef: vi.fn(),
    attributes: {},
    listeners: {},
    transform: null,
    transition: undefined,
    isDragging: false
  }))
}))

vi.mock('../rooms/room-attachment-transfer', () => ({
  readRoomAttachmentPreview: (...args: unknown[]) => mocks.readRoomAttachmentPreview(...args)
}))

vi.mock('@dnd-kit/sortable', async (importOriginal) => ({
  ...(await importOriginal()),
  useSortable: (options: unknown) => mocks.useSortable(options)
}))

vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
  TooltipContent: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('QueuedMessageCard', () => {
  it('keeps sortable ids stable while equivalent queue rows rerender', () => {
    const { result, rerender } = renderHook(({ items }) => useStableQueuedMessageIds(items), {
      initialProps: {
        items: [
          { id: 'a', text: 'first' },
          { id: 'b', text: 'second' }
        ]
      }
    })
    const initial = result.current

    rerender({
      items: [
        { id: 'a', text: 'updated' },
        { id: 'b', text: 'second' }
      ]
    })
    expect(result.current).toBe(initial)
    rerender({
      items: [
        { id: 'b', text: 'second' },
        { id: 'a', text: 'updated' }
      ]
    })
    expect(result.current).not.toBe(initial)
  })

  it('uses one square through hidden, preview, and full queue states', async () => {
    const square = (reveal: 'hidden' | 'preview' | 'full') => (
      <DndContext>
        <RoomQueueSquareGrid phase={reveal === 'hidden' ? 'exiting' : 'visible'} raised={false}>
          <RoomQueueSquare
            participant={
              { id: 'agent', identity: 'agent', displayName: 'Agent' } as RoomParticipant
            }
            count={0}
            expanded={false}
            targeted={false}
            layoutSignature="|agent"
            reveal={reveal}
            exitInFlow
            droppableDisabled
            onToggle={vi.fn()}
            onRegister={vi.fn()}
            onRegisterFull={vi.fn()}
          />
        </RoomQueueSquareGrid>
      </DndContext>
    )
    const { container, rerender } = render(square('hidden'))

    const grid = container.firstElementChild as HTMLElement
    const card = grid.firstElementChild as HTMLElement
    expect(card.style.height).toBe('0px')
    expect(card.style.position).toBe('')

    rerender(square('preview'))
    await waitFor(() => expect(card.style.height).toBe('27px'))
    const clip = card.querySelector('[data-room-queue-square-clip]') as HTMLElement
    const button = screen.getByRole('button', { name: /Queue of/ })
    expect(card.classList.contains('overflow-hidden')).toBe(false)
    expect(card.classList.contains('rounded-lg')).toBe(false)
    expect(clip.classList.contains('overflow-hidden')).toBe(true)
    expect(clip.classList.contains('room-queue-preview-mask--active')).toBe(true)
    expect(button.classList.contains('size-[108px]')).toBe(true)

    rerender(square('full'))
    expect(card.style.height).toBe('108px')
    expect(clip.classList.contains('room-queue-preview-mask--active')).toBe(false)
  })

  it('previews an empty target area and expands every square together', async () => {
    const participants = [
      { id: 'queued', identity: 'queued', displayName: 'Queued' },
      { id: 'empty', identity: 'empty', displayName: 'Empty' }
    ] as RoomParticipant[]
    const squareElements = new Map<string, HTMLElement>()
    const fullSquareElements = new Map<string, HTMLButtonElement>()
    const targets = (entered: boolean, hasQueuedMessage: boolean) => (
      <DndContext>
        <RoomQueueSquareTargets
          participants={participants}
          desiredIds={new Set(['queued', 'empty'])}
          directedRows={(id) => (hasQueuedMessage && id === 'queued' ? [{}] : [])}
          expandedId={null}
          keptSquareId={null}
          hoveredSquareId={null}
          phase="visible"
          dragging
          previewingSharedDrag
          squareTargetsEntered={entered}
          squareElements={squareElements}
          fullSquareElements={fullSquareElements}
          onOpen={vi.fn()}
          onClose={vi.fn()}
          onExited={vi.fn()}
        />
      </DndContext>
    )
    const { container, rerender } = render(targets(false, true))
    const [queued, empty] = screen.getAllByRole('button', { name: /Queue of/ })
    const queuedFrame = queued.parentElement?.parentElement
    const emptyClip = empty.parentElement
    const emptyFrame = empty.parentElement?.parentElement

    await waitFor(() => expect(queuedFrame?.style.height).toBe('108px'))
    expect(emptyFrame?.style.height).toBe('108px')
    expect(emptyClip?.classList.contains('room-queue-preview-mask--active')).toBe(false)
    expect(container.querySelectorAll('[data-room-queue-preview-edge]')).toHaveLength(0)

    rerender(targets(false, false))
    expect(queuedFrame?.style.height).toBe('27px')
    expect(emptyFrame?.style.height).toBe('27px')
    expect(emptyClip?.classList.contains('room-queue-preview-mask--active')).toBe(true)

    rerender(targets(true, false))
    expect(queuedFrame?.style.height).toBe('108px')
    expect(emptyFrame?.style.height).toBe('108px')
    expect(emptyClip?.classList.contains('room-queue-preview-mask--active')).toBe(false)

    rerender(targets(false, false))
    expect(queuedFrame?.style.height).toBe('27px')
    expect(emptyFrame?.style.height).toBe('27px')
    expect(emptyClip?.classList.contains('room-queue-preview-mask--active')).toBe(true)
  })

  it('expands an idle preview before opening an individual queue', async () => {
    const participant = {
      id: 'queued',
      identity: 'queued',
      displayName: 'Queued'
    } as RoomParticipant
    const onOpen = vi.fn()
    const targets = () => (
      <DndContext>
        <RoomQueueSquareTargets
          participants={[participant]}
          desiredIds={new Set(['queued'])}
          directedRows={() => [{}]}
          expandedId={null}
          keptSquareId={null}
          hoveredSquareId={null}
          phase="visible"
          dragging={false}
          previewingSharedDrag={false}
          squareTargetsEntered={false}
          squareElements={new Map()}
          fullSquareElements={new Map()}
          onOpen={onOpen}
          onClose={vi.fn()}
          onExited={vi.fn()}
        />
      </DndContext>
    )
    render(targets())
    const button = screen.getByRole('button', { name: /Queue of/ })
    const frame = button.parentElement?.parentElement

    await waitFor(() => expect(frame?.style.height).toBe('27px'))
    fireEvent.click(button)
    expect(onOpen).not.toHaveBeenCalled()
    expect(frame?.style.height).toBe('108px')
    fireEvent.click(button)
    expect(onOpen).toHaveBeenCalledWith('queued')

    fireEvent.pointerDown(document.body, { button: 0, clientX: 1000, clientY: 1000 })
    expect(frame?.style.height).toBe('27px')
  })

  it('renders short and long formatted previews on one clamped line', () => {
    const { rerender } = render(<QueuedMessageCard item={{ id: 'a', text: 'ping A' }} />)
    expect(screen.getByText('ping A')).toBeTruthy()

    rerender(<QueuedMessageCard item={{ id: 'b', text: `ping B ${'long '.repeat(80)}` }} />)
    const preview = screen.getByText(/ping B/).closest('.truncate')
    expect(preview?.classList.contains('h-4')).toBe(true)
  })

  it('keeps the grip silent and exposes the exact Steer tooltip', () => {
    render(
      <TooltipProvider delayDuration={0}>
        <QueuedMessageCard item={{ id: 'a', text: 'ping A' }} canSteer onSteer={vi.fn()} />
      </TooltipProvider>
    )

    expect(screen.getByLabelText('Reorder queued message')).toBeTruthy()
    expect(screen.queryByText('Reorder queued message')).toBeNull()
    expect(screen.getByText('Submit without interrupting the model')).toBeTruthy()
  })

  it('exposes loaded room image previews to the drag overlay', async () => {
    mocks.readRoomAttachmentPreview.mockResolvedValue({
      mimeType: 'image/png',
      contentBase64: 'aW1hZ2U='
    })
    render(
      <RoomQueuedMessageCard
        data={{ target: { kind: 'local' } } as RoomData}
        message={
          {
            roomId: 'room',
            attachments: [
              { id: 'image-1', fileName: 'image.png', mimeType: 'image/png', byteSize: 5 }
            ]
          } as never
        }
        item={{ id: 'room-message', text: 'with image' }}
      />
    )

    expect(await screen.findByRole('img')).toBeTruthy()
    expect(mocks.useSortable.mock.calls.at(-1)?.[0]).toMatchObject({
      data: {
        item: {
          id: 'room-message',
          images: [{ id: 'image-1', fileName: 'image.png', url: 'data:image/png;base64,aW1hZ2U=' }]
        }
      }
    })
    expect(mocks.readRoomAttachmentPreview).toHaveBeenCalledWith({ kind: 'local' }, 'room', {
      id: 'image-1'
    })
    expect(mocks.readRoomAttachmentPreview).toHaveBeenCalledOnce()
  })

  it('keeps portaled Edit inside an individual queue', async () => {
    render(
      <DndContext>
        <RoomQueueSquareOverlay
          participant={{ id: 'agent', identity: 'agent', displayName: 'Agent' } as RoomParticipant}
          items={[{ id: 'queued', text: 'queued' }]}
          rows={(item) => <QueuedMessageCard item={item} onEdit={vi.fn()} />}
          closing={false}
          onClose={vi.fn()}
          refCallback={() => {}}
        />
      </DndContext>
    )

    fireEvent.pointerDown(screen.getByLabelText('More actions'))
    fireEvent.click(await screen.findByText('Edit'))

    expect(screen.getByRole('textbox')).toBeTruthy()
  })

  it('suppresses a transferred row without an exit-frame flash', () => {
    const { rerender } = render(
      <DndContext>
        <QueuedMessagePresence items={[{ id: 'moving', text: 'moving' }]}>
          {(item) => <QueuedMessageCard item={item} />}
        </QueuedMessagePresence>
      </DndContext>
    )
    expect(screen.getByText('moving')).toBeTruthy()

    rerender(
      <DndContext>
        <QueuedMessagePresence items={[]} suppressExitId="moving">
          {(item) => <QueuedMessageCard item={item} />}
        </QueuedMessagePresence>
      </DndContext>
    )
    expect(screen.queryByText('moving')).toBeNull()
  })
})
