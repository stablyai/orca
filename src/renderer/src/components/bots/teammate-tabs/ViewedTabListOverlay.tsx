// A shared agent's Home showing another person's tabs: drawn over this window's own, which stay
// mounted and untouched underneath.
import { useEffect } from 'react'
import { useBots, useBotsEnabled } from '@/lib/bot-catalog'
import { findBotByWorkspace } from '../bot-workspace'
import { parseWorkspaceKey } from '../../../../../shared/workspace/identity/workspace-scope'
import { useTabListPeople } from './tab-list-people'
import { sameTabListPerson, useViewedTabList, viewTabList } from './viewed-tab-list'
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
  // Someone no longer shared with has no list here: the window goes back to its own tabs.
  const holder = view
    ? (people?.others.find((entry) => sameTabListPerson(entry.person, view.person)) ?? null)
    : null
  const gone = view !== null && bot !== null && holder === null
  useEffect(() => {
    if (gone) {
      viewTabList(worktreeId, null)
    }
  }, [gone, worktreeId])
  if (!view || !bot || !people || !holder) {
    return null
  }
  return (
    <ViewedTabListSurface
      bot={bot}
      homeKey={worktreeId}
      view={view}
      people={people}
      holderName={holder.name}
    />
  )
}
