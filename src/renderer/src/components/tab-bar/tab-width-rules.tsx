import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject
} from 'react'
import { cn } from '@/lib/utils'
import { useAppStore } from '../../store'

// Definite widths prevent live titles from resizing the strip; flex-shrink still allows narrowing to the minimum.
export const TAB_CONTAINER_FIXED_WIDTH_CLASSES = 'w-[180px] min-w-[72px] min-[1280px]:w-[220px]'

// Share crowded strips equally, releasing unused space from tabs that fit their titles.
export const TAB_CONTAINER_FIT_WIDTH_CLASSES = 'min-w-25 max-w-max flex-[1_1_0px]'

export const TAB_ROOT_WIDTH_CLASSES = 'w-full'

export const TAB_LABEL_WIDTH_CLASSES = 'min-w-0 flex-1 truncate'

// Each extra leading glyph is a 12px icon plus the 4px gap before it (w-3 + gap-1).
const TAB_LEADING_SLOT_WIDTH = '1rem'

// Agents can retitle a tab every few seconds; widths wait for the strip to go quiet so tabs move at most once.
const TITLE_QUIET_MS = 3000

type SettledTabTitle = {
  title: string
  leadingSlots: number
  widthKey: string
  renameCount: number
  awaitingRename: boolean
}

type TabTitleWidthStrip = {
  widthKey: string
  /** Lives on the strip so labels that remount (menus, rename) keep their held width. */
  settledByTabId: Map<string, SettledTabTitle>
  noteTitleChange: () => void
}

/** Null keeps fixed-width tabs; otherwise tabs fit titles and re-settle whenever the key changes. */
const TabTitleWidthContext = createContext<TabTitleWidthStrip | null>(null)

/** Settle widths once titles stop changing, never while the pointer is over the strip, and whenever it is shown again. */
export function TabTitleWidthProvider({
  worktreeId,
  shown,
  stripRef,
  children
}: {
  worktreeId: string
  /** Strips outside the worktree switcher (floating panel) report their own visibility. */
  shown?: boolean
  stripRef: RefObject<HTMLElement | null>
  children: React.ReactNode
}): React.JSX.Element {
  const fitsTitles = useAppStore((s) => s.settings?.experimentalFitTabsToTitles === true)
  const worktreeShown = useAppStore((s) => s.activeWorktreeId === worktreeId)
  const isShown = shown ?? worktreeShown
  const [pointerInside, setPointerInside] = useState(false)
  // A hidden strip never receives pointerleave, so drop the hover rather than hold widths on return.
  if (!isShown && pointerInside) {
    setPointerInside(false)
  }
  const held = pointerInside && isShown
  const [settleCount, setSettleCount] = useState(0)
  const [settledByTabId] = useState(() => new Map<string, SettledTabTitle>())
  const quietRef = useRef<{
    pending: boolean
    held: boolean
    timer?: ReturnType<typeof setTimeout>
  }>({ pending: false, held: false })
  const scheduleSettle = useCallback(() => {
    const quiet = quietRef.current
    clearTimeout(quiet.timer)
    quiet.timer = quiet.held
      ? undefined
      : setTimeout(() => {
          quiet.pending = false
          setSettleCount((count) => count + 1)
        }, TITLE_QUIET_MS)
  }, [])
  const noteTitleChange = useCallback(() => {
    quietRef.current.pending = true
    scheduleSettle()
  }, [scheduleSettle])
  useEffect(() => {
    const quiet = quietRef.current
    quiet.held = held
    if (quiet.pending) {
      scheduleSettle()
    }
  }, [held, scheduleSettle])
  useEffect(() => () => clearTimeout(quietRef.current.timer), [])
  useEffect(() => {
    const strip = stripRef.current
    if (!fitsTitles || !strip) {
      return
    }
    const enter = (): void => setPointerInside(true)
    const leave = (): void => setPointerInside(false)
    strip.addEventListener('pointerenter', enter)
    strip.addEventListener('pointerleave', leave)
    return () => {
      strip.removeEventListener('pointerenter', enter)
      strip.removeEventListener('pointerleave', leave)
      setPointerInside(false)
    }
  }, [fitsTitles, stripRef])
  const widthKey = fitsTitles ? `${isShown ? 'shown' : 'hidden'}:${settleCount}` : null
  const strip = useMemo(() => {
    if (widthKey === null) {
      // Forget held titles so re-enabling the setting starts from live titles.
      settledByTabId.clear()
      return null
    }
    return { widthKey, settledByTabId, noteTitleChange }
  }, [widthKey, settledByTabId, noteTitleChange])
  return <TabTitleWidthContext.Provider value={strip}>{children}</TabTitleWidthContext.Provider>
}

export function useFitsTabsToTitles(): boolean {
  return useContext(TabTitleWidthContext) !== null
}

export type TabTitleRename = { count: number; title: string | null }

/** Hold the width-defining title and icon count until the strip settles or the user renames, so agent renames and status changes can't keep shifting tabs. */
function useSettledTabTitle(
  tabId: string,
  title: string,
  leadingSlots: number,
  rename: TabTitleRename | undefined
): { settledTitle: string; settledSlots: number } {
  const strip = useContext(TabTitleWidthContext)
  let settledTitle = title
  let settledSlots = leadingSlots
  if (strip !== null) {
    const { widthKey, settledByTabId } = strip
    const previous = settledByTabId.get(tabId)
    const next = nextSettledTabTitle(previous, {
      title,
      leadingSlots,
      widthKey,
      renameCount: rename?.count ?? 0,
      renamedTo: rename?.title
    })
    if (next !== previous) {
      // Idempotent for a given key and title, so a discarded render cannot leave a wrong width.
      settledByTabId.set(tabId, next)
    }
    settledTitle = next.title
    settledSlots = next.leadingSlots
  }
  const noteTitleChange = strip?.noteTitleChange
  const pending = settledTitle !== title || settledSlots !== leadingSlots
  useEffect(() => {
    if (pending) {
      noteTitleChange?.()
    }
  }, [pending, title, leadingSlots, noteTitleChange])
  return { settledTitle, settledSlots }
}

function nextSettledTabTitle(
  previous: SettledTabTitle | undefined,
  live: {
    title: string
    leadingSlots: number
    widthKey: string
    renameCount: number
    renamedTo: string | null | undefined
  }
): SettledTabTitle {
  const { title, leadingSlots, widthKey, renameCount, renamedTo } = live
  if (!previous || previous.widthKey !== widthKey) {
    return {
      title,
      leadingSlots,
      widthKey,
      renameCount,
      awaitingRename: false
    }
  }
  if (previous.renameCount !== renameCount) {
    // A host may normalize or clear the committed name, so the next title change also settles.
    return {
      title,
      leadingSlots,
      widthKey,
      renameCount,
      awaitingRename: title !== renamedTo
    }
  }
  if (previous.awaitingRename && previous.title !== title) {
    return { ...previous, title, awaitingRename: false }
  }
  return previous
}

export function TabTitleLabel({
  tabId,
  title,
  leadingSlots = 1,
  rename,
  className
}: {
  tabId: string
  title: string
  /** Glyphs in the tab's leading icon; the label absorbs changes until the strip settles. */
  leadingSlots?: number
  /** The user's latest inline rename; its result may arrive after a host round trip. */
  rename?: TabTitleRename
  className?: string
}): React.JSX.Element {
  const { settledTitle, settledSlots } = useSettledTabTitle(tabId, title, leadingSlots, rename)
  const slotShift = settledSlots - leadingSlots
  if (settledTitle === title && slotShift === 0) {
    return <span className={cn(TAB_LABEL_WIDTH_CLASSES, 'mr-1', className)}>{title}</span>
  }
  return (
    // The hidden pseudo-element sizes the tab from the settled title without duplicating text content;
    // its margin gives back (or takes) the width the leading icon gained (or lost) since the strip settled.
    <span
      data-settled-title={settledTitle}
      style={
        {
          '--tab-slot-shift': `calc(${slotShift} * ${TAB_LEADING_SLOT_WIDTH})`
        } as React.CSSProperties
      }
      className={cn(
        'relative mr-1 min-w-0 flex-1 overflow-hidden whitespace-nowrap before:invisible before:inline-block before:mr-(--tab-slot-shift) before:content-[attr(data-settled-title)]',
        className
      )}
    >
      <span className="absolute inset-0 truncate">{title}</span>
    </span>
  )
}
