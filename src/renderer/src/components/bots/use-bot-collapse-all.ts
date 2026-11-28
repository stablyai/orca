import { useCallback, useMemo } from 'react'
import { useAppStore } from '@/store'
import {
  changedCollapsedGroupKeys,
  recordCollapsedGroupChanges
} from '@/store/slices/ui/collapsed-group-toggle'
import { getLineageGroupKey } from '../../../../shared/sidebar-list/sections/group-keys'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { hasBotSidebarChildPresence, useBotSidebarChildren } from './bot-sidebar-child-presence'

export type BotCollapseAll = {
  /** Every listed bot that can fold is folded, so the toggle unfolds them all. */
  allCollapsed: boolean
  toggle: () => void
}

type BotEntry = { kind: 'bot'; id: string; home: { id: string } } | { kind: 'group' }

function botFoldKeys(entries: readonly BotEntry[]): Set<string> {
  return new Set(
    entries.flatMap((entry) =>
      entry.kind === 'bot' ? [getLineageGroupKey(folderWorkspaceKey(entry.home.id))] : []
    )
  )
}

/** How many of `keys` are folded, walking whichever set is smaller. */
function countFolded(keys: ReadonlySet<string>, folded: ReadonlySet<string>): number {
  let count = 0
  const [walk, other] = keys.size <= folded.size ? [keys, folded] : [folded, keys]
  for (const key of walk) {
    if (other.has(key)) {
      count += 1
    }
  }
  return count
}

const NONE = 0
const SOME = 1
const ALL = 2

/** Known fold changes update counts directly; hydration and unknown replacements recount. */
function createFoldState(
  saved: ReadonlySet<string>,
  withChildren: ReadonlySet<string>
): (folded: ReadonlySet<string>) => number {
  let seen: ReadonlySet<string> | null = null
  let state = NONE
  let childFolds = 0
  let savedFolds = 0
  return (folded) => {
    if (folded !== seen) {
      const keys = seen ? changedCollapsedGroupKeys(seen, folded) : undefined
      if (keys !== undefined) {
        for (const key of keys) {
          const delta = folded.has(key) ? 1 : -1
          childFolds += withChildren.has(key) ? delta : 0
          savedFolds += saved.has(key) ? delta : 0
        }
      } else {
        childFolds = countFolded(withChildren, folded)
        savedFolds = countFolded(saved, folded)
      }
      seen = folded
      state =
        childFolds < withChildren.size ? SOME : withChildren.size > 0 || savedFolds > 0 ? ALL : NONE
    }
    return state
  }
}

/**
 * Folds every listed bot with chats or workspaces, as each bot's own chevron does; unfolds every
 * bot folded, listed or hidden. Null when no listed bot can fold and no saved bot is folded.
 */
export function useBotCollapseAll(
  entries: readonly BotEntry[],
  savedEntries: readonly BotEntry[]
): BotCollapseAll | null {
  const hasChildren = useBotSidebarChildren()
  const saved = useMemo(() => botFoldKeys(savedEntries), [savedEntries])
  // Groups have nothing under their row to fold; offscreen bots haven't reported children yet.
  const foldable = useMemo(
    () =>
      new Set(
        entries.flatMap((entry) =>
          entry.kind === 'bot' && (hasChildren(entry.id) || !hasBotSidebarChildPresence(entry.id))
            ? [getLineageGroupKey(folderWorkspaceKey(entry.home.id))]
            : []
        )
      ),
    [entries, hasChildren]
  )
  const foldState = useMemo(() => createFoldState(saved, foldable), [saved, foldable])
  const state = useAppStore((s) => foldState(s.collapsedGroups))
  const allCollapsed = state === ALL
  const toggle = useCallback(() => {
    const { collapsedGroups, setCollapsedGroups } = useAppStore.getState()
    const next = new Set(collapsedGroups)
    const toFold = allCollapsed ? saved : foldable
    if (allCollapsed) {
      for (const key of saved) {
        next.delete(key)
      }
    } else {
      for (const key of toFold) {
        next.add(key)
      }
    }
    setCollapsedGroups(recordCollapsedGroupChanges(collapsedGroups, next, toFold))
  }, [allCollapsed, foldable, saved])
  return state === NONE ? null : { allCollapsed, toggle }
}
