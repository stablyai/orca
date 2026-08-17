import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent
} from '@dnd-kit/core'
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable'
import { cn } from '@/lib/utils'
import type { RoomData } from './use-room-data'
import type { QueuedMessageItem } from '../native-chat/QueuedMessageCard'
import { useQueuedMessageContainerPresence } from '../native-chat/QueuedMessageList'
import { RoomQueueSquareGrid, RoomQueueSquareTargets } from './RoomQueueSquare'
import { RoomDirectedQueueOverlay } from './RoomDirectedQueueOverlay'
import { RoomQueueDragOverlay } from './RoomQueueDragOverlay'
import { showRoomActionError } from './room-action-error'
import { SharedQueueZone } from './RoomQueueDropZone'
import { RoomSharedQueueList } from './RoomSharedQueueList'
import type { RoomQueueComposerEdit } from './room-queue-composer-edit'
import { executeRoomQueueAction, useRoomQueueEditRequest } from './room-queue-action-executor'
import { roomDirectedQueueItems, roomSharedQueueItems } from './room-queue-items'
import {
  projectRoomSharedQueueItems,
  roomSharedQueuePlacement,
  type RoomSharedQueuePlacement
} from './room-shared-queue-placement'
import { useRoomQueueSquarePresence } from './use-room-queue-square-presence'
import {
  computeRoomQueueState,
  isRoomQueueTransfer,
  isRoomQueueTransferSettled,
  isMessageMutable,
  parseSharedRowId,
  resolveRoomQueueDrop,
  roomQueueDropKeepsParticipantOpen,
  roomQueueDropParticipantId,
  SHARED_ZONE_ID,
  squareOpenId
} from './room-queue-state'
import {
  clearRoomQueueLongPress,
  roomQueueCollision,
  roomQueueDropTarget,
  roomQueueLongPressTarget,
  roomQueuePointerForDrag,
  pointInRect,
  roomQueuePointInSquareBounds,
  trackRoomQueuePointer,
  updateRoomQueueLongPress,
  type RoomQueueLongPressState,
  type RoomQueuePointer
} from './room-queue-drag-targeting'

const NOOP_EDIT = (): void => {}

export function RoomDeliveryQueues({
  data,
  editing = null,
  onEdit = NOOP_EDIT
}: {
  data: RoomData
  editing?: RoomQueueComposerEdit | null
  onEdit?: (edit: RoomQueueComposerEdit) => void
}): React.JSX.Element | null {
  const state = useMemo(() => computeRoomQueueState(data), [data])
  const [dragging, setDragging] = useState(false)
  const [pointerDragging, setPointerDragging] = useState(false)
  const [squareTargetsEntered, setSquareTargetsEntered] = useState(false)
  const [activeDragItem, setActiveDragItem] = useState<QueuedMessageItem | null>(null)
  const [sharedPlacement, setSharedPlacement] = useState<RoomSharedQueuePlacement | null>(null)
  const [hoveredSquareId, setHoveredSquareId] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [closingId, setClosingId] = useState<string | null>(null)
  const [keptSquareId, setKeptSquareId] = useState<string | null>(null)
  const settlingDragId = dragging ? null : activeDragItem?.id
  const previewingSharedDrag =
    dragging && pointerDragging && parseSharedRowId(activeDragItem?.id ?? '') !== null
  if (isRoomQueueTransferSettled(state, settlingDragId)) {
    setActiveDragItem(null)
  }
  const longPress = useRef<RoomQueueLongPressState>({ targetId: null, timer: null })
  const dragBrowseActive = useRef(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastPointer = useRef<RoomQueuePointer | null>(null)
  const squareElements = useRef(new Map<string, HTMLElement>())
  const fullSquareElements = useRef(new Map<string, HTMLButtonElement>())
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const queueAreaRef = useRef<HTMLDivElement | null>(null)
  const sharedZoneRef = useRef<HTMLDivElement | null>(null)
  const sharedPlacementRef = useRef<RoomSharedQueuePlacement | null>(null)
  const registerSharedZone = useCallback((element: HTMLDivElement | null) => {
    sharedZoneRef.current = element
  }, [])
  const editRequest = useRoomQueueEditRequest(data, onEdit, showRoomActionError)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )
  const clearLongPress = (): void => clearRoomQueueLongPress(longPress.current)
  useEffect(
    () => () => {
      clearLongPress()
      if (closeTimer.current) {
        clearTimeout(closeTimer.current)
      }
    },
    []
  )
  const closeSquare = useCallback((): void => {
    if (expandedId) {
      setExpandedId(null)
      setClosingId(expandedId)
      closeTimer.current = setTimeout(() => setClosingId(null), 200)
    }
  }, [expandedId])
  const directedRows = useCallback(
    (participantId: string) =>
      (state?.directed.get(participantId) ?? []).filter(
        (delivery) => delivery.messageId !== editing?.message.id && delivery.id !== settlingDragId
      ),
    [editing?.message.id, settlingDragId, state]
  )
  useEffect(() => trackRoomQueuePointer((point) => (lastPointer.current = point)), [])
  const squarePresence = useRoomQueueSquarePresence({
    state,
    dragging,
    dragSettling: activeDragItem !== null,
    keptSquareId,
    expandedId,
    directedRows,
    closeExpanded: closeSquare
  })
  const hasContent = Boolean(
    state &&
    (dragging || state.shared.length > 0 || state.hasDirected || squarePresence.squares.length > 0)
  )
  const containerPresence = useQueuedMessageContainerPresence(hasContent)
  if (!state || !containerPresence.mounted) {
    return null
  }
  const { participants, squares } = squarePresence

  const supportsEdit = data.snapshot?.queueComposerEditVersion === 1
  const sharedItems = roomSharedQueueItems(data, state, editing?.message.id).filter(
    (item) => item.id !== settlingDragId
  )

  const openSquare = (participantId: string): void => {
    if (expandedId === participantId) {
      return
    }
    clearLongPress()
    if (closeTimer.current) {
      clearTimeout(closeTimer.current)
    }
    setClosingId(null)
    setExpandedId(participantId)
  }

  const onDragStart = ({ active, activatorEvent }: DragStartEvent): void => {
    clearLongPress()
    dragBrowseActive.current = expandedId !== null
    setHoveredSquareId(null)
    setSquareTargetsEntered(false)
    sharedPlacementRef.current = null
    setSharedPlacement(null)
    const id = String(active.id)
    const messageId = parseSharedRowId(id) ?? data.deliveries[id]?.messageId
    const message = messageId ? data.messages.find((item) => item.id === messageId) : undefined
    if (!message || message.actorKind !== 'user' || !isMessageMutable(data, message.id)) {
      return
    }
    const visualItem = active.data.current?.item as QueuedMessageItem | undefined
    setActiveDragItem({
      ...visualItem,
      id,
      text: message.body,
      dragDisabled: true,
      canEdit: false,
      canRemove: false
    })
    setPointerDragging(roomQueuePointerForDrag({ activatorEvent }, lastPointer.current) !== null)
    setDragging(true)
  }
  const updateSharedPlacement = (event: DragMoveEvent | DragOverEvent): void => {
    const activeId = String(event.active.id)
    const next =
      parseSharedRowId(activeId) === null
        ? roomSharedQueuePlacement(event, lastPointer.current, sharedItems)
        : null
    sharedPlacementRef.current = next
    setSharedPlacement((current) =>
      current?.overMessageId === next?.overMessageId &&
      current?.after === next?.after &&
      current?.index === next?.index
        ? current
        : next
    )
  }
  const updateDragHover = (event: DragMoveEvent | DragOverEvent): void => {
    const point = roomQueuePointerForDrag(event, lastPointer.current)
    const pointInOverlay = Boolean(
      point && overlayRef.current && pointInRect(point, overlayRef.current.getBoundingClientRect())
    )
    if (previewingSharedDrag && point && !pointInOverlay) {
      const elements = squareTargetsEntered ? fullSquareElements.current : squareElements.current
      const entered = roomQueuePointInSquareBounds(point, elements)
      setSquareTargetsEntered((current) => (current === entered ? current : entered))
    }
    const targetId = roomQueueLongPressTarget({
      activatorEvent: event.activatorEvent,
      point: lastPointer.current,
      squares: squareElements.current,
      overlay: overlaySurface
    })
    setHoveredSquareId(targetId)
    if (targetId) {
      if (dragBrowseActive.current) {
        clearLongPress()
        openSquare(targetId)
      } else {
        updateRoomQueueLongPress(longPress.current, targetId, (participantId) => {
          dragBrowseActive.current = true
          openSquare(participantId)
        })
      }
      return
    }
    clearLongPress()
    if (pointInOverlay) {
      return
    }
    if (
      point &&
      queueAreaRef.current &&
      pointInRect(point, queueAreaRef.current.getBoundingClientRect())
    ) {
      closeSquare()
      return
    }
    const overId = event.over ? String(event.over.id) : null
    if (overId === SHARED_ZONE_ID || (overId && parseSharedRowId(overId) !== null)) {
      closeSquare()
    }
  }
  const resetDragState = (keepActiveItem = false): void => {
    clearLongPress()
    dragBrowseActive.current = false
    setHoveredSquareId(null)
    setPointerDragging(false)
    setSquareTargetsEntered(false)
    setDragging(false)
    if (!keepActiveItem) {
      setActiveDragItem(null)
    }
    sharedPlacementRef.current = null
    setSharedPlacement(null)
  }
  const onDragEnd = (event: DragEndEvent): void => {
    const activeId = String(event.active.id)
    const overId = roomQueueDropTarget(
      event,
      lastPointer.current,
      squareElements.current,
      overlaySurface,
      sharedZoneRef.current
    )
    const placement =
      roomSharedQueuePlacement(event, lastPointer.current, sharedItems) ??
      sharedPlacementRef.current
    const actions = resolveRoomQueueDrop(data, state, activeId, overId, placement ?? undefined)
    const transfer = actions.some(isRoomQueueTransfer)
    resetDragState(transfer)
    if (!roomQueueDropKeepsParticipantOpen(actions, expandedId)) {
      closeSquare()
    }
    const targetParticipantId = roomQueueDropParticipantId(actions)
    if (transfer && targetParticipantId) {
      setKeptSquareId(targetParticipantId)
    }
    const execution = Promise.all(
      actions.map((action) => executeRoomQueueAction(data, action, showRoomActionError))
    )
    if (transfer) {
      void execution.then((results) =>
        setActiveDragItem((current) =>
          results.includes(false) && current?.id === activeId ? null : current
        )
      )
    }
    if (transfer && targetParticipantId) {
      void execution.finally(() =>
        setKeptSquareId((current) => (current === targetParticipantId ? null : current))
      )
    }
  }

  const expandedParticipant =
    participants.find((participant) => participant.id === (expandedId ?? closingId)) ?? null
  const expandedQueueItems = roomDirectedQueueItems(
    data,
    expandedParticipant,
    expandedParticipant ? directedRows(expandedParticipant.id) : []
  )
  const expandedItems =
    activeDragItem && sharedPlacement
      ? expandedQueueItems.filter((item) => item.id !== activeDragItem.id)
      : expandedQueueItems
  const overlaySurface = {
    elementRef: overlayRef,
    targetId: expandedParticipant ? squareOpenId(expandedParticipant.id) : null,
    itemIds: new Set(expandedQueueItems.map((item) => item.id))
  }
  const draggingDirected = Boolean(
    dragging && activeDragItem && !parseSharedRowId(activeDragItem.id)
  )
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={(args) => roomQueueCollision(args, overlaySurface)}
      onDragStart={onDragStart}
      onDragMove={(event) => {
        updateDragHover(event)
        updateSharedPlacement(event)
      }}
      onDragOver={(event) => {
        updateDragHover(event)
        updateSharedPlacement(event)
      }}
      onDragEnd={onDragEnd}
      onDragCancel={() => {
        resetDragState()
        closeSquare()
      }}
    >
      <div
        className={cn(
          'grid shrink-0 transition-[grid-template-rows,opacity] duration-200 motion-reduce:transition-none',
          containerPresence.visible ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
        )}
      >
        <div className="min-h-0 overflow-hidden px-4 pt-2">
          <div ref={queueAreaRef} className="relative mx-auto w-full max-w-4xl">
            <RoomQueueSquareGrid phase={squarePresence.phase} raised={draggingDirected}>
              <div className="min-h-0 overflow-hidden">
                <RoomQueueSquareTargets
                  participants={squares}
                  desiredIds={squarePresence.desiredIds}
                  directedRows={directedRows}
                  expandedId={expandedId}
                  keptSquareId={keptSquareId}
                  hoveredSquareId={hoveredSquareId}
                  phase={squarePresence.phase}
                  dragging={dragging}
                  previewingSharedDrag={previewingSharedDrag}
                  squareTargetsEntered={squareTargetsEntered}
                  squareElements={squareElements.current}
                  fullSquareElements={fullSquareElements.current}
                  onOpen={openSquare}
                  onClose={closeSquare}
                  onExited={squarePresence.removeExited}
                />
              </div>
            </RoomQueueSquareGrid>
            <SharedQueueZone refCallback={registerSharedZone}>
              <RoomSharedQueueList
                data={data}
                items={projectRoomSharedQueueItems(sharedItems, activeDragItem, sharedPlacement)}
                supportsEdit={supportsEdit}
                editing={Boolean(editing)}
                editPending={editRequest.pending}
                projectedIndex={draggingDirected ? (sharedPlacement?.index ?? null) : null}
                suppressExitId={settlingDragId}
                onEdit={editRequest.begin}
              />
            </SharedQueueZone>
            {expandedParticipant ? (
              <RoomDirectedQueueOverlay
                data={data}
                participant={expandedParticipant}
                items={expandedItems}
                supportsEdit={supportsEdit}
                editing={Boolean(editing)}
                editPending={editRequest.pending}
                closing={expandedId !== expandedParticipant.id}
                suppressExitId={settlingDragId}
                report={showRoomActionError}
                onEdit={editRequest.begin}
                onClose={closeSquare}
                refCallback={(element) => void (overlayRef.current = element)}
              />
            ) : null}
          </div>
        </div>
      </div>
      <RoomQueueDragOverlay item={dragging ? activeDragItem : null} />
    </DndContext>
  )
}
