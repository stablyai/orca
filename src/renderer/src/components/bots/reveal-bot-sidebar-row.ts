import { useAppStore } from '@/store'
import { BOTS_GROUP_KEY } from '../../../../shared/sidebar-list/sections/group-keys'
import { readBotsEnabled } from '@/lib/bot-catalog'
import { botSidebarVirtualScrollers } from './bot-sidebar-virtual-scroll'
import { botGroupFoldToOpen } from './bot-group-folders'
import { readBotGroups } from '@/lib/bot-group-catalog-snapshot'

const READY_DEADLINE_MS = 500

// One owner for "show a Bots row": the sidebar search (focuses the row's name) and Cmd+K (never moves focus).

/** Scrolls only the bot list, never its overflow-hidden ancestors, so the sidebar shell can't shift. */
function scrollListToRow(list: HTMLElement, row: HTMLElement): void {
  const listBox = list.getBoundingClientRect()
  const rowBox = row.getBoundingClientRect()
  if (rowBox.top < listBox.top) {
    list.scrollTop -= listBox.top - rowBox.top
  } else if (rowBox.bottom > listBox.bottom) {
    list.scrollTop += rowBox.bottom - listBox.bottom
  }
}

function findListedRow(
  sidebarKey: string,
  getList: () => HTMLElement | null
): { list: HTMLElement; row: HTMLElement } | null {
  const list = getList()
  const row = list?.querySelector<HTMLElement>(
    `[data-bot-sidebar-entry="${CSS.escape(sidebarKey)}"]`
  )
  return list && row ? { list, row } : null
}

/**
 * Unfolds Bots if folded, then scrolls the entry's row into the list's view.
 * Checks `isCurrent` before unfolding and before scrolling or focusing. Returns a cancel.
 */
export function revealBotSidebarRow({
  sidebarKey,
  isCurrent,
  focusName,
  defer = true,
  getList = () => document.querySelector<HTMLElement>('[data-bot-sidebar-list]')
}: {
  /** `botSidebarEntryKey`: the row's `data-bot-sidebar-entry`, host-qualified. */
  sidebarKey: string
  isCurrent: () => boolean
  focusName: boolean
  /** Sidebar search has already committed its list with flushSync. */
  defer?: boolean
  /** The scrolling list; read at the frame, after the unfold has mounted it. */
  getList?: () => HTMLElement | null
}): () => void {
  let frame: number | null = null
  let cancelled = false
  const cancel = (): void => {
    cancelled = true
    if (frame !== null) {
      cancelAnimationFrame(frame)
      frame = null
    }
  }
  if (!isCurrent()) {
    return cancel
  }
  const store = useAppStore.getState()
  if (store.collapsedGroups.has(BOTS_GROUP_KEY)) {
    store.toggleCollapsedGroup(BOTS_GROUP_KEY)
  }
  // A bot in folded groups shows once one of them unfolds, a frame later.
  const groupFold = botGroupFoldToOpen(sidebarKey, readBotGroups(), store.collapsedGroups)
  if (groupFold) {
    store.toggleCollapsedGroup(groupFold)
  }
  let retries = defer || groupFold ? 1 : 0
  let seekDeadline: number | null = null
  const step = (): void => {
    frame = null
    if (cancelled || !isCurrent()) {
      return
    }
    const found = findListedRow(sidebarKey, getList)
    if (!found) {
      const list = getList()
      if (seekDeadline === null && list && botSidebarVirtualScrollers.get(list)?.(sidebarKey)) {
        seekDeadline = performance.now() + READY_DEADLINE_MS
      }
      if (seekDeadline === null ? retries-- > 0 : performance.now() < seekDeadline) {
        frame = requestAnimationFrame(step)
      }
      return
    }
    const card = found.row.querySelector<HTMLElement>('[data-worktree-card-surface]')
    scrollListToRow(found.list, card ?? found.row)
    if (focusName) {
      found.row
        .querySelector<HTMLElement>('[data-worktree-title-inline-rename]')
        ?.focus({ preventScroll: true })
    }
  }
  if (defer) {
    frame = requestAnimationFrame(step)
  } else {
    step()
  }
  return cancel
}

// The sidebar's bot search hides the list while it shows results; a reveal then has nothing to show.
let sidebarSearchHasQuery = false

export function setBotSidebarSearchHasQuery(hasQuery: boolean): void {
  sidebarSearchHasQuery = hasQuery
}

/**
 * Whether Cmd+K may reveal this entry: the sidebar shows an unfolded Bots section, the entry is listed under
 * the current view options, and the sidebar's own search isn't showing results. When false, nothing changes.
 */
export function canRevealBotSidebarEntry(entry: {
  kind: 'bot' | 'group'
  paused: boolean
}): boolean {
  const state = useAppStore.getState()
  return (
    state.sidebarOpen &&
    !state.collapsedGroups.has(BOTS_GROUP_KEY) &&
    (state.sidebarBody ?? 'workspaces') !== 'agents' &&
    readBotsEnabled() &&
    !(entry.kind === 'bot' && entry.paused && state.botSidebarView.hidePausedBots) &&
    !sidebarSearchHasQuery
  )
}

// A palette selection made, or a palette opened, after a bot's open began supersedes its reveal.
let paletteSelectionGeneration = 0

export function advanceBotPaletteGeneration(): number {
  paletteSelectionGeneration += 1
  return paletteSelectionGeneration
}

export function currentBotPaletteGeneration(): number {
  return paletteSelectionGeneration
}

/** Focus sits inside the opened tab's own pane (its chat, room or terminal), not just its workspace. */
function destinationTabHasFocus(tabId: string): boolean {
  const active = document.activeElement
  if (!(active instanceof Element)) {
    return false
  }
  const id = CSS.escape(tabId)
  return (
    active.closest(
      `[data-structured-agent-session-overlay-tab-id="${id}"], [data-room-overlay-tab-id="${id}"], [data-terminal-tab-id="${id}"]`
    ) !== null
  )
}

/**
 * Cmd+K's reveal: once the opened tab has committed and holds focus, scrolls to an already-unfolded row,
 * never moving focus. Every step re-checks, live: no newer palette opening or selection, still within the
 * deadline, focus still in that tab, and the entry still listed under the current view options.
 */
export function revealBotSidebarRowAfterOpen({
  sidebarKey,
  readEntry,
  generation,
  destinationTabId
}: {
  sidebarKey: string
  /** The entry as it is now: null once removed. */
  readEntry: () => { kind: 'bot' | 'group'; paused: boolean } | null
  generation: number
  /** The tab the open showed: the bot's chat, the group's room, or the home's active tab. */
  destinationTabId: string
}): void {
  const deadline = performance.now() + READY_DEADLINE_MS
  const live = (): boolean =>
    generation === currentBotPaletteGeneration() && performance.now() < deadline
  const eligible = (): boolean => {
    const entry = readEntry()
    return entry !== null && canRevealBotSidebarEntry(entry)
  }
  const wait = (): void => {
    if (!live()) {
      return
    }
    if (!destinationTabHasFocus(destinationTabId)) {
      requestAnimationFrame(wait)
      return
    }
    revealBotSidebarRow({
      sidebarKey,
      // Checked right before the unfold and in each deferred frame: nothing changes once any fails.
      isCurrent: () => live() && destinationTabHasFocus(destinationTabId) && eligible(),
      focusName: false
    })
  }
  requestAnimationFrame(wait)
}
