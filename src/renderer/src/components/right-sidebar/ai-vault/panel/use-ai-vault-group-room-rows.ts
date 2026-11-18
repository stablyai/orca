import { useMemo } from 'react'
import { useBotsEnabled } from '@/lib/bot-catalog'
import { useBotGroups } from '@/lib/bot-group-list'
import { collapseBotGroupRoomRows, placeBotGroupRoomRows } from '@/lib/bot-group-room-history'
import { useAppStore } from '@/store'
import { selectFolderWorkspaces } from '@/store/workspaces/catalog/workspace-record-fields'
import type { AiVaultRoomRows } from '../session-list/ai-vault-session-filters'

/** A group room's member rows in Session History: placed in the group's home before filters
 *  run, then folded into the one row that reopens the room. */
export function useAiVaultGroupRoomRows(): AiVaultRoomRows {
  const groups = useBotGroups(useBotsEnabled())
  const folders = useAppStore(selectFolderWorkspaces)
  return useMemo(() => {
    const homePathOf = (id: string) =>
      folders?.find((folder) => folder.id === id)?.folderPath ?? null
    return {
      place: (rows) => placeBotGroupRoomRows(rows, groups, homePathOf),
      fold: (rows) => collapseBotGroupRoomRows(rows, groups)
    }
  }, [folders, groups])
}
