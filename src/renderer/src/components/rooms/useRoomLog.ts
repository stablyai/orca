import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { LOCAL, type Room, type RoomLine } from './room-types'

export function useRoomLog(roomId: string | null) {
  const [lines, setLines] = useState<RoomLine[]>([])
  const [pending, setPending] = useState<
    {
      key: string
      roomId: string
      seq: number
      text: string
      targetMemberId?: string
      createdAt: string
    }[]
  >([])
  const pendingSeq = useRef(-1)
  const activeRoomId = useRef(roomId)
  activeRoomId.current = roomId
  const addPendingMessage = useCallback(
    (messageRoomId: string, text: string, targetMemberId?: string) => {
      pendingSeq.current -= 1
      const seq = pendingSeq.current
      const key = `pending:${seq}`
      const createdAt = new Date().toISOString()
      setPending((current) => [
        ...current,
        {
          key,
          roomId: messageRoomId,
          seq,
          text,
          ...(targetMemberId ? { targetMemberId } : {}),
          createdAt
        }
      ])
      return key
    },
    []
  )
  const discardPendingMessage = useCallback((key: string) => {
    setPending((current) => current.filter((message) => message.key !== key))
  }, [])
  const refresh = useCallback(async (options?: { silent?: boolean }) => {
    if (!roomId) {
      setLines([])
      return
    }
    try {
      const result = await callRuntimeRpc<{ room: Room; lines: RoomLine[] }>(
        LOCAL,
        'orchestration.roomLog',
        { id: roomId }
      )
      if (activeRoomId.current !== roomId) {
        return
      }
      setLines(result.lines)
      setPending((current) =>
        current.filter(
          (message) =>
            message.roomId !== roomId ||
            !result.lines.some(
              (line) => !line.memberId && line.seq >= 0 && line.text === message.text
            )
        )
      )
    } catch (error) {
      if (!options?.silent) {
        toast.error(
        `${translate('auto.components.rooms.useRoomLog.readFailed', 'Failed to read room log')}: ${error instanceof Error ? error.message : String(error)}`
      )
      }
    }
  }, [roomId])
  useEffect(() => {
    setPending([])
    void refresh()
    if (!roomId) {
      return
    }
    const timer = setInterval(() => void refresh({ silent: true }), 3000)
    return () => clearInterval(timer)
  }, [refresh, roomId])
  const pendingLines = useMemo(
    () =>
      pending
        .filter((message) => message.roomId === roomId)
        .map<RoomLine>((message) => ({
          seq: message.seq,
          who: 'You',
          memberId: null,
          text: message.text,
          kind: null,
          ...(message.targetMemberId ? { targetMemberId: message.targetMemberId } : {}),
          createdAt: message.createdAt
        })),
    [pending, roomId]
  )
  return {
    lines: [...lines, ...pendingLines],
    refresh,
    addPendingMessage,
    discardPendingMessage
  }
}
