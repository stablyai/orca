import { translate } from '@/i18n/i18n'
import { BROWSER_NAVIGATION_ACTION_ID } from './browser-navigation-action'
import {
  CMD_J_PALETTE_VIEWS,
  cmdJPaletteViewShows,
  getCmdJPaletteViewLabel,
  type CmdJPaletteView,
  type CmdJPaletteViewSection
} from './palette-view'
import type {
  HintRow,
  QuickActionPaletteItem,
  SettingsPaletteItem
} from '../worktree-jump-palette-model'

export type CmdJPaletteViewCounts = Record<CmdJPaletteView, number>

export function cmdJPaletteMiddleItemSection(
  item: SettingsPaletteItem | QuickActionPaletteItem
): CmdJPaletteViewSection {
  return item.type === 'quick-action' && item.result.id === BROWSER_NAVIGATION_ACTION_ID
    ? 'browser-navigation'
    : 'middle'
}

/** Mirrors exactly what each view would list, so a tab never reads 0 over a visible row. */
export function buildCmdJPaletteViewCounts(items: {
  worktrees: number
  projects: number
  openTabs: number
  tasks: number
  middleItems: readonly (SettingsPaletteItem | QuickActionPaletteItem)[]
}): CmdJPaletteViewCounts {
  const countFor = (view: CmdJPaletteView): number => {
    const shows = (section: CmdJPaletteViewSection): boolean => cmdJPaletteViewShows(view, section)
    return (
      (shows('worktrees') ? items.worktrees : 0) +
      (shows('projects') ? items.projects : 0) +
      (shows('open-tabs') ? items.openTabs : 0) +
      (shows('tasks') ? items.tasks : 0) +
      items.middleItems.filter((item) => shows(cmdJPaletteMiddleItemSection(item))).length
    )
  }
  return {
    worktrees: countFor('worktrees'),
    tabs: countFor('tabs'),
    actions: countFor('actions'),
    all: countFor('all')
  }
}

/** Nearest view (in Tab order, All last) holding matches when the current view has none. */
export function pickCmdJPaletteAlternateView(
  view: CmdJPaletteView,
  counts: CmdJPaletteViewCounts | null
): CmdJPaletteView | null {
  if (!counts || counts[view] > 0) {
    return null
  }
  const start = CMD_J_PALETTE_VIEWS.indexOf(view)
  const ordered = CMD_J_PALETTE_VIEWS.map(
    (_, offset) => CMD_J_PALETTE_VIEWS[(start + offset + 1) % CMD_J_PALETTE_VIEWS.length]
  )
  return (
    ordered.find((candidate) => candidate !== 'all' && counts[candidate] > 0) ??
    (counts.all > 0 ? 'all' : null)
  )
}

export function buildCmdJPaletteAlternateViewHint(
  view: CmdJPaletteView,
  counts: CmdJPaletteViewCounts,
  showView: (view: CmdJPaletteView) => void
): HintRow {
  return {
    id: '__hint_alternate_view__',
    type: 'hint',
    label: translate('worktreeJumpPalette.view.matchesIn', '{{value0}} in {{value1}}', {
      value0: counts[view],
      value1: getCmdJPaletteViewLabel(view)
    }),
    actionLabel: translate('worktreeJumpPalette.view.show', 'Show'),
    onSeeMore: () => showView(view)
  }
}
