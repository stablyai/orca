import {
  createContext,
  memo,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type Ref
} from 'react'
import { useShallow } from 'zustand/react/shallow'
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type { QueuedMessageCard } from './structured-agent-session-queued-cards'
import type { QueuedMessageReorder } from './use-structured-agent-session-queued-reorder'

export type QueuedMessageDragPresentation = {
  rowRef: Ref<HTMLLIElement>
  rowStyle: CSSProperties
  grip: ReactNode
  insertion: 'before' | 'after' | undefined
}

type Props = {
  cards: QueuedMessageCard[]
  reorder?: QueuedMessageReorder
  renderCard: (card: QueuedMessageCard, drag?: QueuedMessageDragPresentation) => ReactNode
}

// Consume fresh render callbacks below the memoized sortable hooks.
const QueuedMessageRenderer = createContext<{
  renderCard: Props['renderCard']
  move: QueuedMessageReorder['move']
} | null>(null)
const pointerOptions = { activationConstraint: { distance: 4 } }

export function NativeChatQueuedMessageRows(props: Props): ReactNode {
  if (!props.reorder) {
    return props.cards.map((card) => props.renderCard(card))
  }
  // A changed membership or host cancels a drag; order publications keep stable row identities.
  const membership = props.cards
    .map((card) => card.messageId)
    .sort()
    .join('\u0000')
  return (
    <SortableQueuedMessages
      key={`${props.reorder.scope}:${membership}`}
      {...props}
      reorder={props.reorder}
    />
  )
}

function SortableQueuedMessages({
  cards,
  reorder,
  renderCard
}: Props & { reorder: QueuedMessageReorder }): React.JSX.Element {
  const mounted = useRef(false)
  useLayoutEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const sensors = useSensors(useSensor(PointerSensor, pointerOptions))
  const users = useShallow((input: QueuedMessageCard[]) =>
    input.filter((card) => !card.from && card.hold !== 'sending').map((card) => card.messageId)
  )(cards)
  const [drag, setDrag] = useState<{ from: string; over: string } | null>(null)
  const fromIndex = drag ? users.indexOf(drag.from) : -1
  const overIndex = drag ? users.indexOf(drag.over) : -1
  const renderer = useMemo(() => ({ renderCard, move: reorder.move }), [renderCard, reorder.move])
  return (
    <QueuedMessageRenderer.Provider value={renderer}>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={({ active }) => setDrag({ from: String(active.id), over: String(active.id) })}
        onDragOver={({ active, over }) =>
          setDrag(over ? { from: String(active.id), over: String(over.id) } : null)
        }
        onDragCancel={() => setDrag(null)}
        onDragEnd={({ active, over }) => {
          setDrag(null)
          if (!mounted.current || !over || active.id === over.id) {
            return
          }
          const from = users.indexOf(String(active.id))
          const to = users.indexOf(String(over.id))
          if (from !== -1 && to !== -1) {
            void reorder.move(
              String(active.id),
              from < to ? { afterMessageId: String(over.id) } : { beforeMessageId: String(over.id) }
            )
          }
        }}
      >
        <SortableContext items={users} strategy={verticalListSortingStrategy}>
          {cards.map((card) => (
            <SortableQueuedMessage
              key={card.messageId}
              card={card}
              users={users}
              pending={reorder.pending}
              insertion={
                card.messageId === drag?.over && fromIndex !== overIndex
                  ? fromIndex < overIndex
                    ? 'after'
                    : 'before'
                  : undefined
              }
            />
          ))}
        </SortableContext>
      </DndContext>
    </QueuedMessageRenderer.Provider>
  )
}

const SortableQueuedMessage = memo(function SortableQueuedMessage({
  card,
  users,
  pending,
  insertion
}: {
  card: QueuedMessageCard
  users: string[]
  pending: boolean
  insertion: QueuedMessageDragPresentation['insertion']
}): ReactNode {
  const sortable = useSortable({
    id: card.messageId,
    disabled: !!card.from || card.hold === 'sending' || pending
  })
  return (
    <QueuedMessagePresentation
      card={card}
      users={users}
      pending={pending}
      insertion={insertion}
      sortable={sortable}
    />
  )
})

function QueuedMessagePresentation({
  card,
  users,
  pending,
  insertion,
  sortable
}: {
  card: QueuedMessageCard
  users: string[]
  pending: boolean
  insertion: QueuedMessageDragPresentation['insertion']
  sortable: ReturnType<typeof useSortable>
}): ReactNode {
  const renderer = useContext(QueuedMessageRenderer)
  if (!renderer) {
    throw new Error('Queued message renderer is missing')
  }
  const movable = !card.from && card.hold !== 'sending'
  const label = translate('components.native-chat.queuedMessages.reorderMessage', 'Reorder message')
  return renderer.renderCard(card, {
    rowRef: sortable.setNodeRef,
    rowStyle: {
      transform: CSS.Transform.toString(sortable.transform),
      transition: sortable.transition
    },
    insertion,
    grip: movable ? (
      <span className="inline-flex shrink-0 opacity-0 group-hover/queued:opacity-100 has-[:focus-visible]:opacity-100 [@media(hover:none)]:opacity-100">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              ref={sortable.setActivatorNodeRef}
              className="cursor-grab touch-none active:cursor-grabbing"
              {...sortable.attributes}
              {...sortable.listeners}
              aria-label={label}
              aria-keyshortcuts="ArrowUp ArrowDown"
              aria-disabled={pending}
              onKeyDown={(event) => {
                if (pending || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) {
                  return
                }
                event.preventDefault()
                const index = users.indexOf(card.messageId)
                const neighbor = users[index + (event.key === 'ArrowUp' ? -1 : 1)]
                if (neighbor) {
                  void renderer.move(
                    card.messageId,
                    event.key === 'ArrowUp'
                      ? { beforeMessageId: neighbor }
                      : { afterMessageId: neighbor }
                  )
                }
              }}
            >
              <GripVertical className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {translate(
              'components.native-chat.queuedMessages.reorderHint',
              'Drag to reorder, or use the Up and Down arrow keys.'
            )}
          </TooltipContent>
        </Tooltip>
      </span>
    ) : null
  })
}
