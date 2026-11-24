import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { translate } from '@/i18n/i18n'
import { installWindowVisibilityInterval } from '@/lib/window-activity/window-visibility-interval'
import { useActiveWorktreeId } from '@/store/workspaces/selection/use-selected-worktree'
import { useAllWorktrees } from '@/store/slices/worktrees/listing/use-worktree-catalog'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { LOCAL, type Room } from './room-types'

async function fetchRoomsWithSettled(onSettled: () => void): Promise<Room[]> {
  try {
    const result = await callRuntimeRpc<{ rooms: Room[] }>(LOCAL, 'orchestration.roomList')
    return result.rooms
  } finally {
    onSettled()
  }
}

export function useRooms() {
  // Why: subscribe to language changes so toasts and room state re-render translated.
  useTranslation()
  const [rooms, setRooms] = useState<Room[]>([])
  const [loading, setLoading] = useState(true)
  const activeWorktreeId = useActiveWorktreeId()
  const worktrees = useAllWorktrees()
  const ensuredHq = useRef(false)
  const refresh = useCallback(async (options?: { silent?: boolean }) => {
    try {
      setRooms(await fetchRoomsWithSettled(() => setLoading(false)))
    } catch (error) {
      if (!options?.silent) {
        toast.error(
          `${translate('auto.components.rooms.useRooms.listFailed', 'Failed to list rooms')}: ${(error as Error).message}`
        )
      }
    }
  }, [])
  useEffect(() => {
    void refresh()
  }, [refresh])
  useEffect(() => {
    return installWindowVisibilityInterval({
      run: () => void refresh({ silent: true }),
      intervalMs: 3_000
    })
  }, [refresh])
  const ensureWorktreeId = activeWorktreeId ?? worktrees[0]?.id
  useEffect(() => {
    if (ensuredHq.current || !ensureWorktreeId) {
      return
    }
    ensuredHq.current = true
    void (async () => {
      try {
        const created = await callRuntimeRpc<{ room: Room; adminSeated: boolean }>(
          LOCAL,
          'orchestration.roomEnsureMainBot',
          { worktree: `id:${ensureWorktreeId}`, agent: 'codex' }
        )
        setRooms((cur) => {
          const rest = cur.filter((r) => r.id !== created.room.id)
          return [...rest, created.room]
        })
        if (created.adminSeated) {
          toast.success(
            translate('auto.components.rooms.useRooms.adminReady', 'Orca Admin is ready in Orca HQ')
          )
        }
      } catch (error) {
        ensuredHq.current = false
        toast.error(
          `${translate('auto.components.rooms.useRooms.seatMainBotFailed', 'Failed to seat the Main Bot')}: ${(error as Error).message}`
        )
      }
    })()
  }, [ensureWorktreeId])
  return { rooms, loading, refresh }
}
