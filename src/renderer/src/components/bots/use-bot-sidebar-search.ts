import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { toast } from 'sonner'
import { openBotGroup } from '@/lib/bot-group-catalog'
import { useAppStore } from '@/store'
import {
  BOTS_GROUP_KEY,
  getLineageGroupKey
} from '../../../../shared/sidebar-list/sections/group-keys'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { openBotFromSidebar } from './BotRow'
import type { BotSearchEntry } from './BotSearchResultRow'
import { pruneBotAutoUnfoldMemory } from './bot-auto-unfold-memory'
import { botErrorMessage } from './bot-presentation'
import { pruneBotSidebarChildren } from './bot-sidebar-child-presence'
import { pruneBotSidebarPaging } from './bot-sidebar-paging'
import { revealBotSidebarRow } from './reveal-bot-sidebar-row'

export type BotSidebarSearchState = {
  open: boolean
  /** Opened by the user, not restored at startup: only then does the field take focus. */
  focusField: boolean
  toggleOpen: () => void
  buttonRef: React.RefObject<HTMLButtonElement | null>
  /** The search field, its results and the list: focus here leaves with the search. */
  regionRef: React.RefObject<HTMLDivElement | null>
  /** Esc: close and put focus back on the toggle. */
  cancel: () => void
  /** Opens a result; it closes the search and shows the entry's row unless something newer came first. */
  select: (entry: BotSearchEntry) => void
  /** The query changed, or focus left the search: a result still opening no longer touches the search. */
  supersede: () => void
  /** The section fold clicked while searching ends the search; true when that was all it did. */
  endForFold: () => boolean
  /** "Reveal current" wins over a query whose results hide the list it reveals in: that search ends. */
  endForReveal: () => void
}

function focusIsNowhere(): boolean {
  const focused = document.activeElement
  return !focused || focused === document.body || !focused.isConnected
}

/**
 * The Bots section's search session. One generation fences everything a selection does after it
 * starts (a group's open, its error, closing, unfolding, the row focus): any newer action ends it.
 */
export function useBotSidebarSearch({
  listRef,
  savedEntries,
  onOpenBot
}: {
  listRef: React.RefObject<HTMLDivElement | null>
  savedEntries: readonly (
    | { kind: 'bot'; home: { id: string }; id: string }
    | { kind: 'group'; id: string }
  )[]
  onOpenBot: () => void
}): BotSidebarSearchState {
  const [open, setOpen] = useState(false)
  const [restored, setRestored] = useState(false)
  const [restoreChecked, setRestoreChecked] = useState(false)
  const [dropSavedQuery, setDropSavedQuery] = useState(false)
  const persistedUIReady = useAppStore((s) => s.persistedUIReady)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const regionRef = useRef<HTMLDivElement>(null)
  const generation = useRef(0)
  const savedCollapsed = useAppStore((s) => s.collapsedGroups.has(BOTS_GROUP_KEY))

  const endSession = useCallback((): number => {
    generation.current += 1
    return generation.current
  }, [])
  useEffect(() => () => void endSession(), [endSession])

  const hasEntries = savedEntries.length > 0
  const hasBots = useMemo(() => savedEntries.some((entry) => entry.kind === 'bot'), [savedEntries])
  const [hadEntries, setHadEntries] = useState(hasEntries)
  const [hadBots, setHadBots] = useState(hasBots)
  if (hadEntries !== hasEntries || hadBots !== hasBots) {
    setHadEntries(hasEntries)
    setHadBots(hasBots)
    if (!hasEntries || (hadBots && !hasBots)) {
      setOpen(false)
      setDropSavedQuery(true)
    }
  }
  // A search left open at quit comes back once the list can show it, so the filter is never unexplained.
  useLayoutEffect(() => {
    if (restoreChecked || !persistedUIReady || !hasEntries) {
      return
    }
    setRestoreChecked(true)
    // Read once, not subscribed: typing must not rerender the whole section.
    if (useAppStore.getState().botSidebarSearchQuery.trim() !== '') {
      setOpen(true)
      setRestored(true)
    }
  }, [restoreChecked, persistedUIReady, hasEntries])
  // A closed search saves no query; the store can't be written during render, so this waits for the commit.
  useLayoutEffect(() => {
    if (dropSavedQuery) {
      setDropSavedQuery(false)
      useAppStore.getState().setBotSidebarSearchQuery('')
    }
  }, [dropSavedQuery])
  const close = useCallback((): void => {
    setOpen(false)
    setRestored(false)
    useAppStore.getState().setBotSidebarSearchQuery('')
  }, [])
  // In the same commit, so no result still opening can act once the search has gone.
  useLayoutEffect(() => {
    if (!hasEntries || !hasBots) {
      endSession()
    }
  }, [hasEntries, hasBots, endSession])

  const complete = useCallback(
    (entryId: string): void => {
      const session = generation.current
      // Closing takes the field and results away; move focus to the row only if it would go with them.
      const moveFocus = focusIsNowhere() || !!regionRef.current?.contains(document.activeElement)
      flushSync(() => {
        const { collapsedGroups, toggleCollapsedGroup } = useAppStore.getState()
        if (collapsedGroups.has(BOTS_GROUP_KEY)) {
          toggleCollapsedGroup(BOTS_GROUP_KEY)
        }
        close()
      })
      if (!moveFocus) {
        return
      }
      revealBotSidebarRow({
        sidebarKey: entryId,
        isCurrent: () =>
          session === generation.current &&
          (focusIsNowhere() || !!regionRef.current?.contains(document.activeElement)),
        focusName: true,
        defer: false,
        getList: () => listRef.current
      })
    },
    [listRef, close]
  )

  const select = useCallback(
    (entry: BotSearchEntry): void => {
      const session = endSession()
      if (entry.kind === 'bot') {
        if (openBotFromSidebar(entry.bot, onOpenBot)) {
          complete(entry.id)
        }
        return
      }
      void openBotGroup(entry.group).then(
        () => {
          if (session === generation.current) {
            onOpenBot()
            complete(entry.id)
          }
        },
        (error: unknown) => {
          if (session === generation.current) {
            toast.error(botErrorMessage(error))
          }
        }
      )
    },
    [complete, endSession, onOpenBot]
  )

  const cancel = useCallback((): void => {
    endSession()
    close()
    buttonRef.current?.focus()
  }, [endSession, close])

  const endForFold = (): boolean => {
    endSession()
    if (!open) {
      return false
    }
    close()
    // Search opens only from the unfolded header; a fold another writer saved mid-search just stays.
    return savedCollapsed
  }

  // No focus move: the reveal's own button keeps it, and the list it reveals in is where the eye goes.
  const endForReveal = useCallback((): void => {
    if (listRef.current?.closest('[data-bot-sidebar-list-under-results]')) {
      endSession()
      close()
    }
  }, [endSession, listRef, close])

  // Forget what removed bots last saw, so the auto-unfold memory doesn't grow.
  useEffect(() => {
    const liveKeys = new Set(savedEntries.map((entry) => entry.id))
    pruneBotSidebarChildren(liveKeys)
    pruneBotSidebarPaging(liveKeys)
    pruneBotAutoUnfoldMemory(
      new Set(
        savedEntries.flatMap((entry) =>
          entry.kind === 'bot' ? [getLineageGroupKey(folderWorkspaceKey(entry.home.id))] : []
        )
      )
    )
  }, [savedEntries])

  return {
    open,
    focusField: !restored,
    toggleOpen: () => {
      endSession()
      if (open) {
        close()
      } else {
        // An open the user asked for always takes focus, whatever closed the last one.
        setRestored(false)
        setOpen(true)
      }
    },
    buttonRef,
    regionRef,
    cancel,
    select,
    supersede: endSession,
    endForFold,
    endForReveal
  }
}
