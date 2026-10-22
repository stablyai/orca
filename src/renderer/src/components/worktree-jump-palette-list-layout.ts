import { translate } from '@/i18n/i18n'
import { CREATE_WORKTREE_ITEM_ID } from '@/lib/worktree-palette-create-action'
import { BROWSER_NAVIGATION_ACTION_ID } from '@/components/cmd-j/browser-navigation-action'
import {
  appendPaletteListEntries,
  CONTINUED_SECTION_HEADER_ID_SUFFIX,
  type PaletteListEntry,
  type PaletteSectionKey
} from './worktree-jump-palette-model'
import type { WorktreeJumpPaletteSections } from './use-worktree-jump-palette-sections'
import type { WorktreeJumpPaletteLocalState } from './use-worktree-jump-palette-local-state'
import type { WorktreeJumpPaletteTaskSearch } from './use-worktree-jump-palette-task-search'

export type WorktreeJumpPaletteListLayoutInput = Pick<
  WorktreeJumpPaletteSections,
  | 'openTabsLeadSections'
  | 'paletteSections'
  | 'showCreateAction'
  | 'handleExpandSection'
  | 'middleLeadsSections'
> &
  Pick<WorktreeJumpPaletteLocalState, 'taskSourceUrl'> &
  Pick<WorktreeJumpPaletteTaskSearch, 'taskItems'> & { hasQuery: boolean }

export function buildWorktreeJumpPaletteListEntries({
  hasQuery,
  openTabsLeadSections,
  paletteSections,
  showCreateAction,
  taskSourceUrl,
  handleExpandSection,
  middleLeadsSections,
  taskItems
}: WorktreeJumpPaletteListLayoutInput): PaletteListEntry[] {
  const entries: PaletteListEntry[] = []
  const {
    visibleWorktreeItems,
    visibleProjectTargetItems,
    visibleMiddleItems: middleItems,
    visibleOpenTabItems,
    worktreeOverflowCount,
    projectTargetOverflowCount,
    middleOverflowCount,
    openTabOverflowCount,
    multiPrimaryFirstScreen,
    multiPrimaryLayout
  } = paletteSections
  // Exact entity matches keep priority; issue/PR URLs keep their jump and create rows first.
  const browserNavigationItem =
    taskSourceUrl || !paletteSections.hasExactEntityDestination
      ? middleItems.find(
          (item) => item.type === 'quick-action' && item.result.id === BROWSER_NAVIGATION_ACTION_ID
        )
      : undefined
  const visibleMiddleItems = middleItems.filter((item) => item !== browserNavigationItem)
  const pushTasks = (): void => {
    if (taskItems.length) {
      entries.push({
        id: '__header_tasks__',
        type: 'section-header',
        section: 'tasks',
        label: translate('worktreeJumpPalette.tasksHeader', 'Tasks')
      })
      appendPaletteListEntries(entries, taskItems)
    }
  }
  const pushOverflowHint = (
    id: string,
    section: PaletteSectionKey,
    overflowCount: number
  ): void => {
    if (overflowCount > 0) {
      entries.push({
        id,
        type: 'hint',
        section,
        label: translate('worktreeJumpPalette.renderCapOverflow', '{{value0}} more', {
          value0: overflowCount
        }),
        onSeeMore: () => handleExpandSection(section)
      })
    }
  }
  const showWorktreeHeader = visibleWorktreeItems.length > 0
  const showOpenTabsHeader = visibleOpenTabItems.length > 0
  const showProjectTargetHeader = visibleProjectTargetItems.length > 0
  const showMiddleHeader = visibleMiddleItems.length > 0
  const pushOpenTabsHeader = (idSuffix = ''): void => {
    if (!showOpenTabsHeader) {
      return
    }
    entries.push({
      id: `__header_open_tabs__${idSuffix}`,
      type: 'section-header',
      section: 'open-tabs',
      label: hasQuery
        ? translate('auto.components.WorktreeJumpPalette.50a1d11d5b', 'Open Tabs')
        : translate(
            'auto.components.WorktreeJumpPalette.recentChatsTerminalsHeader',
            'Recent Chats & Terminals'
          )
    })
  }
  const pushWorktreesHeader = (idSuffix = ''): void => {
    if (!showWorktreeHeader) {
      return
    }
    entries.push({
      id: `__header_worktrees__${idSuffix}`,
      type: 'section-header',
      section: 'worktrees',
      label: hasQuery
        ? translate('auto.components.WorktreeJumpPalette.worktreesHeader', 'Workspaces')
        : translate(
            'auto.components.WorktreeJumpPalette.recentWorktreesHeader',
            'Recent Workspaces'
          )
    })
  }
  const pushWorktreeSection = (): void => {
    if (visibleWorktreeItems.length === 0) {
      return
    }
    pushWorktreesHeader()
    appendPaletteListEntries(entries, visibleWorktreeItems)
    pushOverflowHint('__hint_worktree_overflow__', 'worktrees', worktreeOverflowCount)
  }
  const pushOpenTabSection = (): void => {
    if (visibleOpenTabItems.length === 0) {
      return
    }
    pushOpenTabsHeader()
    appendPaletteListEntries(entries, visibleOpenTabItems)
    pushOverflowHint('__hint_open_tab_overflow__', 'open-tabs', openTabOverflowCount)
  }
  const pushProjectAndMiddleSections = (): void => {
    if (visibleProjectTargetItems.length > 0) {
      if (showProjectTargetHeader) {
        entries.push({
          id: '__header_projects_groups__',
          type: 'section-header',
          section: 'projects',
          label: translate(
            'auto.components.WorktreeJumpPalette.projectsGroupsHeader',
            'Projects & Groups'
          )
        })
      }
      appendPaletteListEntries(entries, visibleProjectTargetItems)
      pushOverflowHint('__hint_project_overflow__', 'projects', projectTargetOverflowCount)
    }
    if (visibleMiddleItems.length > 0) {
      if (showMiddleHeader) {
        entries.push({
          id: '__header_actions_settings__',
          type: 'section-header',
          section: 'middle',
          label: translate('auto.components.WorktreeJumpPalette.088d66d980', 'Actions & Settings')
        })
      }
      appendPaletteListEntries(entries, visibleMiddleItems)
      pushOverflowHint('__hint_middle_overflow__', 'middle', middleOverflowCount)
    }
  }
  // Why: a pasted issue/PR URL is decisive. Show linked worktrees first so
  // Enter jumps; keep create available underneath when the user wants a new one.
  if (taskSourceUrl) {
    if (visibleWorktreeItems.length > 0) {
      pushWorktreeSection()
    }
    if (showCreateAction) {
      entries.push({ id: CREATE_WORKTREE_ITEM_ID, type: 'create-worktree' })
    }
    if (browserNavigationItem) {
      entries.push(browserNavigationItem)
    }
    return entries
  }
  if (!hasQuery) {
    pushOpenTabSection()
    pushWorktreeSection()
    return entries
  }
  if (browserNavigationItem) {
    entries.push(browserNavigationItem)
  }
  if (multiPrimaryFirstScreen && multiPrimaryLayout) {
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
    pushLeadingHeader()
    appendPaletteListEntries(entries, multiPrimaryLayout.leadingPreview)
    pushOverflowHint(leadingHintId, leadingSectionKey, multiPrimaryLayout.leadingMoreCount)
    pushTrailingHeader()
    appendPaletteListEntries(entries, multiPrimaryLayout.trailingFloor)
    const hasLeadingRest = multiPrimaryLayout.leadingRest.length > 0
    if (hasLeadingRest) {
      pushLeadingHeader(CONTINUED_SECTION_HEADER_ID_SUFFIX)
      appendPaletteListEntries(entries, multiPrimaryLayout.leadingRest)
      pushOverflowHint(
        `${leadingHintId}_tail`,
        leadingSectionKey,
        multiPrimaryLayout.leadingHardOverflowCount
      )
    }
    if (multiPrimaryLayout.trailingRest.length > 0) {
      if (hasLeadingRest) {
        pushTrailingHeader(CONTINUED_SECTION_HEADER_ID_SUFFIX)
      }
      appendPaletteListEntries(entries, multiPrimaryLayout.trailingRest)
    }
    pushOverflowHint(
      trailingHintId,
      trailingSectionKey,
      multiPrimaryLayout.trailingHardOverflowCount
    )
    pushProjectAndMiddleSections()
    pushTasks()
    if (showCreateAction) {
      entries.push({ id: CREATE_WORKTREE_ITEM_ID, type: 'create-worktree' })
    }
    return entries
  }
  if (middleLeadsSections) {
    pushProjectAndMiddleSections()
  }
  if (openTabsLeadSections) {
    pushOpenTabSection()
  }
  pushWorktreeSection()
  if (!middleLeadsSections) {
    pushProjectAndMiddleSections()
  }
  if (!openTabsLeadSections) {
    pushOpenTabSection()
  }
  pushTasks()
  if (showCreateAction) {
    entries.push({ id: CREATE_WORKTREE_ITEM_ID, type: 'create-worktree' })
  }
  return entries
}
