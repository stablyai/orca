import { createContext, useContext, useMemo, useState } from 'react'
import { cn } from '@/lib/utils'
import { useAppStore } from '../../store'

// Definite widths prevent live titles from resizing the strip; flex-shrink still allows narrowing to the minimum.
export const TAB_CONTAINER_FIXED_WIDTH_CLASSES = 'w-[180px] min-w-[72px] min-[1280px]:w-[220px]'

// Share crowded strips equally, releasing unused space from tabs that fit their titles.
export const TAB_CONTAINER_FIT_WIDTH_CLASSES = 'min-w-25 max-w-max flex-[1_1_0px]'

export const TAB_ROOT_WIDTH_CLASSES = 'w-full'

export const TAB_LABEL_WIDTH_CLASSES = 'min-w-0 flex-1 truncate'

type SettledTabTitle = {
  title: string
  widthKey: string
  renameCount: number
  awaitingRename: boolean
}

type TabTitleWidthStrip = {
  widthKey: string
  /** Lives on the strip so labels that remount (menus, rename) keep their held width. */
  settledByTabId: Map<string, SettledTabTitle>
}

/** Null keeps fixed-width tabs; otherwise tabs fit titles and re-settle whenever the key changes. */
const TabTitleWidthContext = createContext<TabTitleWidthStrip | null>(null)

/** Re-settle widths when tabs open, close, or move, or when the strip is shown again. */
export function TabTitleWidthProvider({
  worktreeId,
  shown,
  tabIds,
  children
}: {
  worktreeId: string
  /** Strips outside the worktree switcher (floating panel) report their own visibility. */
  shown?: boolean
  tabIds: readonly string[]
  children: React.ReactNode
}): React.JSX.Element {
  const fitsTitles = useAppStore((s) => s.settings?.experimentalFitTabsToTitles === true)
  const worktreeShown = useAppStore((s) => s.activeWorktreeId === worktreeId)
  const [settledByTabId] = useState(() => new Map<string, SettledTabTitle>())
  const widthKey = fitsTitles
    ? `${(shown ?? worktreeShown) ? 'shown' : 'hidden'}\n${tabIds.join('\n')}`
    : null
  const strip = useMemo(() => {
    if (widthKey === null) {
      // Forget held titles so re-enabling the setting starts from live titles.
      settledByTabId.clear()
      return null
    }
    return { widthKey, settledByTabId }
  }, [widthKey, settledByTabId])
  return <TabTitleWidthContext.Provider value={strip}>{children}</TabTitleWidthContext.Provider>
}

export function useFitsTabsToTitles(): boolean {
  return useContext(TabTitleWidthContext) !== null
}

export type TabTitleRename = { count: number; title: string | null }

/** Hold the width-defining title until the strip changes or the user renames, so agent renames can't shift tabs. */
function useSettledTabTitle(
  tabId: string,
  title: string,
  rename: TabTitleRename | undefined
): string {
  const strip = useContext(TabTitleWidthContext)
  if (strip === null) {
    return title
  }
  const { widthKey, settledByTabId } = strip
  const renameCount = rename?.count ?? 0
  const previous = settledByTabId.get(tabId)
  const next = nextSettledTabTitle(previous, {
    title,
    widthKey,
    renameCount,
    renamedTo: rename?.title
  })
  if (next !== previous) {
    // Idempotent for a given key and title, so a discarded render cannot leave a wrong width.
    settledByTabId.set(tabId, next)
  }
  return next.title
}

function nextSettledTabTitle(
  previous: SettledTabTitle | undefined,
  live: {
    title: string
    widthKey: string
    renameCount: number
    renamedTo: string | null | undefined
  }
): SettledTabTitle {
  const { title, widthKey, renameCount, renamedTo } = live
  if (!previous || previous.widthKey !== widthKey) {
    return { title, widthKey, renameCount, awaitingRename: false }
  }
  if (previous.renameCount !== renameCount) {
    // A host may normalize or clear the committed name, so the next title change also settles.
    return { title, widthKey, renameCount, awaitingRename: title !== renamedTo }
  }
  if (previous.awaitingRename && previous.title !== title) {
    return { ...previous, title, awaitingRename: false }
  }
  return previous
}

export function TabTitleLabel({
  tabId,
  title,
  rename,
  className
}: {
  tabId: string
  title: string
  /** The user's latest inline rename; its result may arrive after a host round trip. */
  rename?: TabTitleRename
  className?: string
}): React.JSX.Element {
  const settledTitle = useSettledTabTitle(tabId, title, rename)
  if (settledTitle === title) {
    return <span className={cn(TAB_LABEL_WIDTH_CLASSES, 'mr-1', className)}>{title}</span>
  }
  return (
    // The hidden pseudo-element sizes the tab from the settled title without duplicating text content.
    <span
      data-settled-title={settledTitle}
      className={cn(
        'relative mr-1 min-w-0 flex-1 overflow-hidden whitespace-nowrap before:invisible before:content-[attr(data-settled-title)]',
        className
      )}
    >
      <span className="absolute inset-0 truncate">{title}</span>
    </span>
  )
}
