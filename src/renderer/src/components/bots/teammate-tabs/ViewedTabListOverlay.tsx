// A shared agent's Home showing another person's tabs: drawn over this window's own, which stay
// mounted and untouched underneath.
import { useBots, useBotsEnabled } from '@/lib/bot-catalog'
import { findBotByWorkspace } from '../bot-workspace'
import { parseWorkspaceKey } from '../../../../../shared/workspace/identity/workspace-scope'
import { useTabListPeople } from './tab-list-people'
import { useViewedTabList } from './viewed-tab-list'
import { ViewedTabListSurface } from './ViewedTabListSurface'

export function ViewedTabListOverlay({
  worktreeId
}: {
  worktreeId: string
}): React.JSX.Element | null {
  const view = useViewedTabList(worktreeId)
  const botsEnabled = useBotsEnabled()
  const bots = useBots(
    botsEnabled && view !== null && parseWorkspaceKey(worktreeId)?.type === 'folder'
  )
  const bot = view ? findBotByWorkspace(bots, worktreeId) : null
  const people = useTabListPeople(bot)
  if (!view || !bot || !people) {
    return null
  }
  return <ViewedTabListSurface bot={bot} homeKey={worktreeId} view={view} people={people} />
}
