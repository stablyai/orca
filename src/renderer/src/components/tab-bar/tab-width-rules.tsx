import { createContext, useContext, useLayoutEffect, useMemo, type RefObject } from 'react'
import { cn } from '@/lib/utils'
import { useAppStore } from '../../store'

export const TAB_CONTAINER_FIXED_WIDTH_CLASSES = 'w-[180px] min-w-[72px] min-[1280px]:w-[220px]'
export const TAB_CONTAINER_FIT_WIDTH_CLASSES = 'min-w-25 flex-[1_1_0px]'
export const TAB_ROOT_WIDTH_CLASSES = 'w-full'
export const TAB_LABEL_WIDTH_CLASSES = 'min-w-0 flex-1 truncate'

export type TabTitleRename = { count: number; title: string | null }

type TabWidthSnapshot = {
  width: number
  renameCount: number
  awaitingRename: boolean
}

type TabWidthStrip = {
  shown: boolean
  widths: Map<string, TabWidthSnapshot>
}

const TabWidthContext = createContext<TabWidthStrip | null>(null)

/** Refit on workspace return; background title and decoration changes never resize a visible strip. */
export function TabTitleWidthProvider({
  worktreeId,
  shown,
  tabIds,
  children
}: {
  worktreeId: string
  tabIds: readonly string[]
  shown?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const fitsTitles = useAppStore((s) => s.settings?.experimentalFitTabsToTitles === true)
  const worktreeShown = useAppStore((s) => s.activeWorktreeId === worktreeId)
  const isShown = shown ?? worktreeShown
  const strip = useMemo(
    () => (fitsTitles ? { shown: isShown, widths: new Map<string, TabWidthSnapshot>() } : null),
    [fitsTitles, isShown]
  )
  useLayoutEffect(() => {
    const openIds = new Set(tabIds)
    for (const id of strip?.widths.keys() ?? []) {
      if (!openIds.has(id)) {
        strip?.widths.delete(id)
      }
    }
  }, [strip, tabIds])
  return <TabWidthContext.Provider value={strip}>{children}</TabWidthContext.Provider>
}

export function useFitsTabsToTitles(): boolean {
  return useContext(TabWidthContext) !== null
}

export type TabWidthOptions = {
  savedName?: string | null
  rename?: TabTitleRename
  editing?: boolean
  ref?: RefObject<HTMLDivElement | null>
}

/** Snapshot the entire tab's intrinsic width before paint, including controls, without measuring title churn. */
export function useTabWidthSnapshot(
  tabId: string,
  slotRef: RefObject<HTMLDivElement | null>,
  { savedName, rename, editing = false }: TabWidthOptions
): void {
  const strip = useContext(TabWidthContext)
  useLayoutEffect(() => {
    const slot = slotRef.current
    if (!slot) {
      return
    }
    if (!strip) {
      slot.style.removeProperty('width')
      slot.style.removeProperty('max-width')
      return
    }
    if (!strip.shown || editing) {
      return
    }
    const previous = strip.widths.get(tabId)
    const renameCount = rename?.count ?? 0
    const renamed =
      previous !== undefined && renameCount > 0 && previous.renameCount !== renameCount
    const renameArrived = previous?.awaitingRename && savedName === rename?.title
    if (renamed && savedName !== rename?.title) {
      strip.widths.set(tabId, { ...previous, renameCount, awaitingRename: true })
      return
    }
    if (previous && !renamed && !renameArrived) {
      slot.style.width = slot.style.maxWidth = `${previous.width}px`
      return
    }
    const root = slot.querySelector<HTMLElement>(
      '[data-tab-id], [data-client-hosted-browser-row-id]'
    )
    if (!root || root.getClientRects().length === 0) {
      return
    }
    const oldWidth = root.style.width
    root.style.width = 'max-content'
    const width = Math.max(100, root.getBoundingClientRect().width)
    root.style.width = oldWidth
    slot.style.width = slot.style.maxWidth = `${width}px`
    strip.widths.set(tabId, {
      width,
      renameCount,
      awaitingRename: false
    })
  })
}

export function TabTitleLabel({
  title,
  className,
  style,
  onDoubleClick
}: {
  title: string
  className?: string
  style?: React.CSSProperties
  onDoubleClick?: React.MouseEventHandler<HTMLSpanElement>
}): React.JSX.Element {
  return (
    <span
      className={cn(TAB_LABEL_WIDTH_CLASSES, 'mr-1', className)}
      style={style}
      onDoubleClick={onDoubleClick}
    >
      {title}
    </span>
  )
}
