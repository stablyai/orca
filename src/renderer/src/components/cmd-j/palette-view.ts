import { translate } from '@/i18n/i18n'

export type CmdJPaletteView = 'worktrees' | 'tabs' | 'actions' | 'all'

export const CMD_J_PALETTE_VIEWS: readonly CmdJPaletteView[] = [
  'worktrees',
  'tabs',
  'actions',
  'all'
]

export const DEFAULT_CMD_J_PALETTE_VIEW: CmdJPaletteView = 'worktrees'

/** Opening view from `openModal('worktree-palette', { view })`; anything else falls back to Workspaces. */
export function resolveCmdJPaletteOpeningView(modalData: Record<string, unknown>): CmdJPaletteView {
  return CMD_J_PALETTE_VIEWS.find((view) => view === modalData.view) ?? DEFAULT_CMD_J_PALETTE_VIEW
}

export type CmdJPaletteViewSection =
  | 'worktrees'
  | 'open-tabs'
  | 'projects'
  | 'middle'
  | 'browser-navigation'
  | 'tasks'
  | 'create-worktree'

const SECTIONS_BY_VIEW: Record<CmdJPaletteView, ReadonlySet<CmdJPaletteViewSection>> = {
  // Why browser-navigation everywhere: a typed URL + Enter must open it from the default view too.
  worktrees: new Set(['worktrees', 'projects', 'browser-navigation', 'create-worktree']),
  tabs: new Set(['open-tabs', 'browser-navigation']),
  actions: new Set(['middle', 'browser-navigation']),
  all: new Set([
    'worktrees',
    'open-tabs',
    'projects',
    'middle',
    'browser-navigation',
    'tasks',
    'create-worktree'
  ])
}

export function cmdJPaletteViewShows(
  view: CmdJPaletteView,
  section: CmdJPaletteViewSection
): boolean {
  return SECTIONS_BY_VIEW[view].has(section)
}

export function cycleCmdJPaletteView(view: CmdJPaletteView, direction: 1 | -1): CmdJPaletteView {
  const index = CMD_J_PALETTE_VIEWS.indexOf(view)
  const count = CMD_J_PALETTE_VIEWS.length
  return CMD_J_PALETTE_VIEWS[(index + direction + count) % count]
}

export function getCmdJPaletteViewLabel(view: CmdJPaletteView): string {
  switch (view) {
    case 'worktrees':
      return translate('worktreeJumpPalette.view.worktrees', 'Workspaces')
    case 'tabs':
      return translate('worktreeJumpPalette.view.tabs', 'Tabs')
    case 'actions':
      return translate('worktreeJumpPalette.view.actions', 'Actions & Settings')
    case 'all':
      return translate('worktreeJumpPalette.view.all', 'All')
  }
}

export function getCmdJPaletteViewPlaceholder(view: CmdJPaletteView): string {
  switch (view) {
    case 'worktrees':
      return translate(
        'worktreeJumpPalette.view.searchWorktrees',
        'Search workspaces and projects...'
      )
    case 'tabs':
      return translate(
        'worktreeJumpPalette.view.searchTabs',
        'Search chats, terminals, and tabs...'
      )
    case 'actions':
      return translate('worktreeJumpPalette.view.searchActions', 'Search actions and settings...')
    case 'all':
      return translate(
        'auto.components.WorktreeJumpPalette.27f10cca63',
        'Search chats, terminals, workspaces, tasks, settings, and actions...'
      )
  }
}
