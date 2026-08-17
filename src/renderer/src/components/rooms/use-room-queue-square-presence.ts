import { useEffect, useMemo, useRef, useState } from 'react'
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion'
import type { RoomParticipant } from '../../../../shared/rooms'
import type { RoomQueueState } from './room-queue-state'

const EMPTY_PARTICIPANTS: RoomParticipant[] = []

export function useRoomQueueSquarePresence(input: {
  state: RoomQueueState | null
  dragging: boolean
  dragSettling: boolean
  keptSquareId: string | null
  expandedId: string | null
  directedRows: (participantId: string) => readonly unknown[]
  closeExpanded: () => void
}) {
  const { state, dragging, dragSettling, keptSquareId, expandedId, directedRows, closeExpanded } =
    input
  const participants = state?.participants ?? EMPTY_PARTICIPANTS
  const prefersReducedMotion = usePrefersReducedMotion()
  const desiredIds = useMemo(
    () =>
      new Set(
        (dragging
          ? participants
          : participants.filter(
              (participant) =>
                participant.id === keptSquareId ||
                participant.id === expandedId ||
                directedRows(participant.id).length > 0
            )
        ).map((participant) => participant.id)
      ),
    [directedRows, dragging, expandedId, keptSquareId, participants]
  )
  const [renderedIds, setRenderedIds] = useState(() =>
    participants
      .filter((participant) => desiredIds.has(participant.id))
      .map((participant) => participant.id)
  )
  const [previousPresence, setPreviousPresence] = useState({
    desiredIds,
    prefersReducedMotion
  })
  const desiredRef = useRef(desiredIds)
  desiredRef.current = desiredIds
  if (
    desiredIds !== previousPresence.desiredIds ||
    prefersReducedMotion !== previousPresence.prefersReducedMotion
  ) {
    setPreviousPresence({ desiredIds, prefersReducedMotion })
    if (prefersReducedMotion) {
      setRenderedIds(
        participants
          .filter((participant) => desiredIds.has(participant.id))
          .map((participant) => participant.id)
      )
    } else {
      setRenderedIds((current) => {
        const rendered = new Set([...current, ...desiredIds])
        return participants
          .filter((participant) => rendered.has(participant.id))
          .map((participant) => participant.id)
      })
    }
  }
  useEffect(() => {
    if (
      !dragging &&
      !dragSettling &&
      expandedId &&
      state &&
      directedRows(expandedId).length === 0
    ) {
      closeExpanded()
    }
  }, [closeExpanded, directedRows, dragSettling, dragging, expandedId, state])
  return {
    participants,
    desiredIds,
    phase:
      desiredIds.size > 0
        ? ('visible' as const)
        : renderedIds.length > 0
          ? ('exiting' as const)
          : ('hidden' as const),
    squares: renderedIds.flatMap((id) => {
      const participant = participants.find((candidate) => candidate.id === id)
      return participant ? [participant] : []
    }),
    removeExited: (id: string): void => {
      if (!desiredRef.current.has(id)) {
        setRenderedIds((current) => current.filter((candidate) => candidate !== id))
      }
    }
  }
}
