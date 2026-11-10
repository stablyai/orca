import type { MultiPrimarySectionLayout } from '@/components/cmd-j/palette-section-render-cap'
import type { PaletteExtraSlot } from './worktree-jump-palette-extra-list-entries'
import {
  appendPaletteListEntries,
  CONTINUED_SECTION_HEADER_ID_SUFFIX,
  type PaletteItem,
  type PaletteListEntry
} from './worktree-jump-palette-model'

/** Typed first screen when both Open Tabs and Workspaces match: preview, floor, then the rest. */
export function appendMultiPrimaryPaletteSections({
  entries,
  layout,
  openTabsLeadSections,
  pushOpenTabsHeader,
  pushWorktreesHeader,
  pushOverflowHint,
  handleExpandSection,
  pushExtras
}: {
  entries: PaletteListEntry[]
  layout: MultiPrimarySectionLayout<PaletteItem>
  openTabsLeadSections: boolean
  pushOpenTabsHeader: (idSuffix?: string) => void
  pushWorktreesHeader: (idSuffix?: string) => void
  pushOverflowHint: (id: string, overflowCount: number, onSeeMore?: () => void) => void
  handleExpandSection: (sectionKey: string) => void
  pushExtras: (slot: PaletteExtraSlot) => void
}): void {
  const leadingSectionKey = openTabsLeadSections ? 'open-tabs' : 'worktrees'
  const trailingSectionKey = openTabsLeadSections ? 'worktrees' : 'open-tabs'
  const leadingHintId = openTabsLeadSections
    ? '__hint_open_tab_overflow__'
    : '__hint_worktree_overflow__'
  const trailingHintId = openTabsLeadSections
    ? '__hint_worktree_overflow__'
    : '__hint_open_tab_overflow__'
  const pushLeadingHeader = (idSuffix = ''): void => {
    if (openTabsLeadSections) {
      pushOpenTabsHeader(idSuffix)
    } else {
      pushWorktreesHeader(idSuffix)
    }
  }
  const pushTrailingHeader = (idSuffix = ''): void => {
    if (openTabsLeadSections) {
      pushWorktreesHeader(idSuffix)
    } else {
      pushOpenTabsHeader(idSuffix)
    }
  }
  if (!openTabsLeadSections) {
    pushExtras('before-workspaces')
  }
  pushLeadingHeader()
  appendPaletteListEntries(entries, layout.leadingPreview)
  pushOverflowHint(leadingHintId, layout.leadingMoreCount, () =>
    handleExpandSection(openTabsLeadSections ? 'open-tabs' : 'worktrees')
  )
  if (openTabsLeadSections) {
    pushExtras('before-workspaces')
  }
  pushTrailingHeader()
  appendPaletteListEntries(entries, layout.trailingFloor)
  const hasLeadingRest = layout.leadingRest.length > 0
  if (hasLeadingRest) {
    pushLeadingHeader(CONTINUED_SECTION_HEADER_ID_SUFFIX)
    appendPaletteListEntries(entries, layout.leadingRest)
    pushOverflowHint(`${leadingHintId}_tail`, layout.leadingHardOverflowCount, () =>
      handleExpandSection(leadingSectionKey)
    )
  }
  if (layout.trailingRest.length > 0) {
    if (hasLeadingRest) {
      pushTrailingHeader(CONTINUED_SECTION_HEADER_ID_SUFFIX)
    }
    appendPaletteListEntries(entries, layout.trailingRest)
  }
  pushOverflowHint(trailingHintId, layout.trailingHardOverflowCount, () =>
    handleExpandSection(trailingSectionKey)
  )
}
