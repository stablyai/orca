// A shared agent's Home showing another person's tabs: drawn over this window's own, which stay
// mounted and untouched underneath.
import { useEffect } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { useBots, useBotsEnabled } from '@/lib/bot-catalog'
import { findBotByWorkspace } from '../bot-workspace'
import { parseWorkspaceKey } from '../../../../../shared/workspace/identity/workspace-scope'
import { useTabListPeople, useTabListViews } from './tab-list-people'
import { sameTabListPerson, useViewedTabList, viewTabList } from './viewed-tab-list'
import { ReadAloneChatSurface, ViewedTabListSurface } from './ViewedTabListSurface'

export function ViewedTabListOverlay({
  worktreeId
}: {
  worktreeId: string
}): React.JSX.Element | null {
  const t = useTranslate()
  const view = useViewedTabList(worktreeId)
  const botsEnabled = useBotsEnabled()
  const bots = useBots(
    botsEnabled && view !== null && parseWorkspaceKey(worktreeId)?.type === 'folder'
  )
  const bot = view ? findBotByWorkspace(bots, worktreeId) : null
  const views = useTabListViews(bot)
  const people = useTabListPeople(bot)
  const person = view?.person ?? null
  const holder = person
    ? (people?.others.find((entry) => sameTabListPerson(entry.person, person)) ?? null)
    : null
  // A chat whose person can't be told, or another person's on a host that can't show their tabs
  // (an older one would answer with this window's own list): it reads alone.
  const pickedChat = view?.picked && 'sessionId' in view.picked ? view.picked.sessionId : null
  const readAlone = bot && (person === null || !views) ? pickedChat : null
  // Someone no longer shared with, or an agent no longer shared with this account, has no list
  // here: the window goes back to its own tabs, so sharing again starts there.
  const gone = view !== null && readAlone === null && holder === null
  useEffect(() => {
    if (gone) {
      viewTabList(worktreeId, null)
    }
  }, [gone, worktreeId])
  if (readAlone && bot) {
    return (
      <ReadAloneChatSurface
        bot={bot}
        homeKey={worktreeId}
        sessionId={readAlone}
        note={
          person === null
            ? t(
                'bots.teammateTabs.chatOfUnknownPerson',
                'Can’t tell whose chat this is. Read only.'
              )
            : t(
                'bots.teammateTabs.olderHost',
                'Their tabs need a newer Orca on the agent’s computer. Read only.'
              )
        }
      />
    )
  }
  if (!person || !bot || !people || !holder) {
    return null
  }
  return (
    <ViewedTabListSurface
      bot={bot}
      homeKey={worktreeId}
      view={{ person, picked: view?.picked ?? null }}
      people={people}
      holderName={holder.name}
    />
  )
}
