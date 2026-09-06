import { useEffect, useMemo } from 'react'
import type { Room } from '../../../../shared/rooms'
import type { Tab } from '../../../../shared/tab-types'
import { useAppStore } from '@/store'

const EMPTY_TABS: readonly Tab[] = []

export function useRoomTabs(rooms: Room[]) {
  const worktreeId = useAppStore((state) => state.activeWorktreeId)
  const tabsByWorktree = useAppStore((state) => state.unifiedTabsByWorktree)
  const tabs = worktreeId ? (tabsByWorktree[worktreeId] ?? EMPTY_TABS) : EMPTY_TABS
  const setTabLabel = useAppStore((state) => state.setTabLabel)

  const roomTabs = useMemo(() => tabs.filter((tab) => tab.contentType === 'room'), [tabs])

  useEffect(() => {
    const names = new Map(rooms.map((room) => [room.id, room.name]))
    for (const tab of roomTabs) {
      const name = names.get(tab.entityId)
      if (name && name !== tab.label) {
        setTabLabel(tab.id, name)
      }
    }
  }, [roomTabs, rooms, setTabLabel])
}

export function closeRoomTabs(roomId: string): void {
  const state = useAppStore.getState()
  for (const tabId of getRoomTabIds(state.unifiedTabsByWorktree, roomId)) {
    useAppStore.getState().closeUnifiedTab(tabId)
  }
}

export function getRoomTabIds(
  tabsByWorktree: Record<string, readonly Tab[]>,
  roomId: string
): string[] {
  return Object.values(tabsByWorktree)
    .flat()
    .filter((tab) => tab.contentType === 'room' && tab.entityId === roomId)
    .map((tab) => tab.id)
}
