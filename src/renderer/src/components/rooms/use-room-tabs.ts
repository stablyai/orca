import { useEffect, useMemo } from 'react'
import type { Room } from '../../../../shared/rooms'
import type { Tab } from '../../../../shared/tab-types'
import { useAppStore } from '@/store'

const EMPTY_TABS: readonly Tab[] = []

export function useRoomTabs(rooms: Room[]) {
  const worktreeId = useAppStore((state) => state.activeWorktreeId)
  const tabsByWorktree = useAppStore((state) => state.unifiedTabsByWorktree)
  const tabs = worktreeId ? (tabsByWorktree[worktreeId] ?? EMPTY_TABS) : EMPTY_TABS
  const activeTab = useAppStore((state) => (worktreeId ? state.getActiveTab(worktreeId) : null))
  const setTabLabel = useAppStore((state) => state.setTabLabel)

  const roomTabs = useMemo(() => tabs.filter((tab) => tab.contentType === 'room'), [tabs])
  const roomId = activeTab?.contentType === 'room' ? activeTab.entityId : null

  useEffect(() => {
    const names = new Map(rooms.map((room) => [room.id, room.name]))
    for (const tab of roomTabs) {
      const name = names.get(tab.entityId)
      if (name && name !== tab.label) {
        setTabLabel(tab.id, name)
      }
    }
  }, [roomTabs, rooms, setTabLabel])

  return { roomId }
}
