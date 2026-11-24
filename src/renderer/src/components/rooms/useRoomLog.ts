import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { installWindowVisibilityInterval } from '@/lib/window-activity/window-visibility-interval'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
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
  const refresh = useCallback(async () => {
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
      toast.error(
        `${translate('auto.components.rooms.useRoomLog.readFailed', 'Failed to read room log')}: ${(error as Error).message}`
      )
    }
  }, [roomId])
  useEffect(() => {
    setPending([])
    void refresh()
    if (!roomId) {
      return
    }
    return installWindowVisibilityInterval({ run: () => void refresh(), intervalMs: 3000 })
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
