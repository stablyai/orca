import type { GlobalSettings } from '../../../../shared/types'
import { FLUSH_CARD_CONTENT_PULLBACK } from './worktree-list-indentation'

// Why: evaluate larger section typography on its own before shipping selection chrome.
export const SHOW_SIDEBAR_ACTIVE_REPO_HIGHLIGHT = false

export const DEFAULT_SIDEBAR_SECTION_HEADER_ROW_HEIGHT = 28
export const LARGER_SIDEBAR_SECTION_HEADER_ROW_HEIGHT = 32
export const DEFAULT_FLUSH_CARD_CONTENT_PULLBACK = FLUSH_CARD_CONTENT_PULLBACK
export const LARGER_FLUSH_CARD_CONTENT_PULLBACK = 8
const WORKTREE_REVEAL_TOP_CLEARANCE = 6

export type SidebarSectionHeaderAppearance = {
  enabled: boolean
  headerRowHeight: number
  flushCardContentPullback: number
  revealTopInset: number
}

export function resolveSidebarSectionHeaderAppearance(
  settings: Pick<GlobalSettings, 'experimentalLargerSidebarSections'> | null | undefined
): SidebarSectionHeaderAppearance {
  const enabled = settings?.experimentalLargerSidebarSections === true
  const headerRowHeight = enabled
    ? LARGER_SIDEBAR_SECTION_HEADER_ROW_HEIGHT
    : DEFAULT_SIDEBAR_SECTION_HEADER_ROW_HEIGHT
  return {
    enabled,
    headerRowHeight,
    flushCardContentPullback: enabled
      ? LARGER_FLUSH_CARD_CONTENT_PULLBACK
      : DEFAULT_FLUSH_CARD_CONTENT_PULLBACK,
    revealTopInset: headerRowHeight + WORKTREE_REVEAL_TOP_CLEARANCE
  }
}

export function getSidebarSectionHeaderTitleClassName(enabled: boolean): string {
  return enabled
    ? 'min-w-0 truncate text-sm font-semibold leading-none'
    : 'min-w-0 truncate text-[13px] font-semibold leading-none'
}

export function getSidebarTopSectionTitleClassName(enabled: boolean): string {
  return enabled
    ? 'pl-2 pr-0.5 text-sm font-semibold text-muted-foreground/80 select-none'
    : 'pl-2 pr-0.5 text-xs font-semibold text-muted-foreground/80 select-none'
}

export function getHostSectionHeaderTitleClassName(enabled: boolean): string {
  return enabled
    ? 'min-w-0 truncate text-sm font-semibold leading-none'
    : 'min-w-0 truncate text-[12px] font-semibold leading-none'
}
