import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import {
  getWorktreePaletteSelectionItemIds,
  CREATE_WORKTREE_ITEM_ID
} from '@/lib/workspace/search/worktrees/worktree-palette-create-action'
import { useTranslate } from '@/i18n/use-translate'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import {
  appendPaletteListEntries,
  type PaletteItem,
  type PaletteListEntry
} from './worktree-jump-palette-model'
import { buildPaletteListEntryRenderKeys } from '@/components/cmd-j/palette-list-entry-render-keys'
import { BROWSER_NAVIGATION_ACTION_ID } from '@/components/cmd-j/browser-navigation-action'
import {
  buildPaletteExtraSectionEntries,
  type PaletteExtraSlot
} from './worktree-jump-palette-extra-list-entries'
import { appendMultiPrimaryPaletteSections } from './worktree-jump-palette-multi-primary-entries'
import type { WorktreeJumpPaletteSections } from './use-worktree-jump-palette-sections'
import type { WorktreeJumpPaletteWorktrees } from './use-worktree-jump-palette-worktrees'
import type { WorktreeJumpPaletteLocalState } from './use-worktree-jump-palette-local-state'

import type { WorktreeJumpPaletteTaskSearch } from './use-worktree-jump-palette-task-search'

type WorktreeJumpPaletteListEntriesInput = WorktreeJumpPaletteSections &
  Pick<WorktreeJumpPaletteTaskSearch, 'taskItems'> &
  Pick<WorktreeJumpPaletteWorktrees, 'hasQuery'> &
  Pick<WorktreeJumpPaletteLocalState, 'autoSelectedItemIdRef' | 'taskSourceUrl'> &
  Pick<WorktreeJumpPaletteSections, 'middleLeadsSections' | 'handleExpandSection'>

// cmdk skipped disabled actions; keyboard order and default highlight must too.
function isDisabledPaletteEntry(entry: PaletteListEntry): boolean {
  return entry.type === 'quick-action' && entry.result.disabled === true
}

export function useWorktreeJumpPaletteListEntries({
  hasQuery,
  openTabsLeadSections,
  paletteSections,
  showCreateAction,
  autoSelectedItemIdRef,
  taskSourceUrl,
  handleExpandSection,
  middleLeadsSections,
  taskItems
}: WorktreeJumpPaletteListEntriesInput) {
  const t = useTranslate()
  const languageRevision = useUiLanguageRevision()
  const { listEntries, defaultSelectionStart } = useMemo(() => {
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
      multiPrimaryLayout,
      visibleExtraSections
    } = paletteSections
    // Exact entity matches keep priority; issue/PR URLs keep their jump and create rows first.
    const browserNavigationItem =
      taskSourceUrl || !paletteSections.hasExactEntityDestination
        ? middleItems.find(
            (item) =>
              item.type === 'quick-action' && item.result.id === BROWSER_NAVIGATION_ACTION_ID
          )
        : undefined
    const visibleMiddleItems = middleItems.filter((item) => item !== browserNavigationItem)
    const pushTasks = (): void => {
      if (taskItems.length) {
        entries.push({
          id: '__header_tasks__',
          type: 'section-header',
          label: t('worktreeJumpPalette.tasksHeader', 'Tasks')
        })
        appendPaletteListEntries(entries, taskItems)
      }
    }
    const pushOverflowHint = (id: string, overflowCount: number, onSeeMore?: () => void): void => {
      if (overflowCount > 0) {
        entries.push({
          id,
          type: 'hint',
          label: t('worktreeJumpPalette.renderCapOverflow', '{{value0}} more', {
            value0: overflowCount
          }),
          onSeeMore
        })
      }
    }
    const pushExtras = (slot: PaletteExtraSlot): void => {
      entries.push(
        ...buildPaletteExtraSectionEntries(visibleExtraSections, slot, t, handleExpandSection)
      )
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
        label: hasQuery
          ? t('auto.components.WorktreeJumpPalette.50a1d11d5b', 'Open Tabs')
          : t(
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
        label: hasQuery
          ? t('auto.components.WorktreeJumpPalette.worktreesHeader', 'Workspaces')
          : t('auto.components.WorktreeJumpPalette.recentWorktreesHeader', 'Recent Workspaces')
      })
    }
    const pushWorktreeSection = (): void => {
      if (visibleWorktreeItems.length === 0) {
        return
      }
      pushWorktreesHeader()
      appendPaletteListEntries(entries, visibleWorktreeItems)
      pushOverflowHint('__hint_worktree_overflow__', worktreeOverflowCount, () =>
        handleExpandSection('worktrees')
      )
    }
    const pushOpenTabSection = (): void => {
      if (visibleOpenTabItems.length === 0) {
        return
      }
      pushOpenTabsHeader()
      appendPaletteListEntries(entries, visibleOpenTabItems)
      pushOverflowHint('__hint_open_tab_overflow__', openTabOverflowCount, () =>
        handleExpandSection('open-tabs')
      )
    }
    const pushProjectAndMiddleSections = (): void => {
      if (visibleProjectTargetItems.length > 0) {
        if (showProjectTargetHeader) {
          entries.push({
            id: '__header_projects_groups__',
            type: 'section-header',
            label: t(
              'auto.components.WorktreeJumpPalette.projectsGroupsHeader',
              'Projects & Groups'
            )
          })
        }
        appendPaletteListEntries(entries, visibleProjectTargetItems)
        pushOverflowHint('__hint_project_overflow__', projectTargetOverflowCount, () =>
          handleExpandSection('projects')
        )
      }
      if (visibleMiddleItems.length > 0) {
        if (showMiddleHeader) {
          entries.push({
            id: '__header_actions_settings__',
            type: 'section-header',
            label: t('auto.components.WorktreeJumpPalette.088d66d980', 'Actions & Settings')
          })
        }
        appendPaletteListEntries(entries, visibleMiddleItems)
        pushOverflowHint('__hint_middle_overflow__', middleOverflowCount, () =>
          handleExpandSection('middle')
        )
      }
    }
    // Issue/PR URLs put linked worktrees first for Enter-to-jump while keeping create underneath.
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
      return { listEntries: entries, defaultSelectionStart: 0 }
    }
    if (!hasQuery) {
      pushExtras({ emptyQuery: 'first' })
      // Rows above this index lead the list without taking the default selection.
      const defaultSelectionStart = entries.length
      pushOpenTabSection()
      pushWorktreeSection()
      pushExtras({ emptyQuery: 'last' })
      return { listEntries: entries, defaultSelectionStart }
    }
    if (browserNavigationItem) {
      entries.push(browserNavigationItem)
    }
    if (multiPrimaryFirstScreen && multiPrimaryLayout) {
      pushExtras('leading')
      appendMultiPrimaryPaletteSections({
        entries,
        layout: multiPrimaryLayout,
        openTabsLeadSections,
        pushOpenTabsHeader,
        pushWorktreesHeader,
        pushOverflowHint,
        handleExpandSection,
        pushExtras
      })
      pushExtras('after-workspaces')
      pushProjectAndMiddleSections()
      pushTasks()
      if (showCreateAction) {
        entries.push({ id: CREATE_WORKTREE_ITEM_ID, type: 'create-worktree' })
      }
      return { listEntries: entries, defaultSelectionStart: 0 }
    }
    if (middleLeadsSections) {
      pushProjectAndMiddleSections()
    }
    pushExtras('leading')
    if (openTabsLeadSections) {
      pushOpenTabSection()
    }
    pushExtras('before-workspaces')
    pushWorktreeSection()
    pushExtras('after-workspaces')
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
    return { listEntries: entries, defaultSelectionStart: 0 }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- translate() reads the UI language implicitly.
  }, [
    handleExpandSection,
    hasQuery,
    middleLeadsSections,
    openTabsLeadSections,
    paletteSections,
    showCreateAction,
    taskSourceUrl,
    taskItems,
    languageRevision,
    t
  ])
  const selectableItems = useMemo<PaletteItem[]>(
    () =>
      listEntries.filter(
        (entry): entry is PaletteItem =>
          entry.type !== 'section-header' &&
          entry.type !== 'hint' &&
          entry.type !== 'create-worktree'
      ),
    [listEntries]
  )
  const listEntryRenderKeys = useMemo(
    () => buildPaletteListEntryRenderKeys(listEntries.map((entry) => entry.id)),
    [listEntries]
  )
  const selectionItemIds = useMemo(
    () =>
      getWorktreePaletteSelectionItemIds(listEntries, listEntryRenderKeys, isDisabledPaletteEntry),
    [listEntries, listEntryRenderKeys]
  )
  // See more expands inside flushSync; its focus handoff reads the committed order from here.
  const selectionItemIdsRef = useRef(selectionItemIds)
  useLayoutEffect(() => {
    selectionItemIdsRef.current = selectionItemIds
  }, [selectionItemIds])
  // null keeps the shared rule: first row, never an unasked Create.
  const defaultSelectionItemId = useMemo(
    () =>
      defaultSelectionStart > 0
        ? (getWorktreePaletteSelectionItemIds(
            listEntries.slice(defaultSelectionStart),
            listEntryRenderKeys.slice(defaultSelectionStart),
            isDisabledPaletteEntry
          )[0] ?? null)
        : null,
    [defaultSelectionStart, listEntries, listEntryRenderKeys]
  )
  useEffect(() => {
    autoSelectedItemIdRef.current = defaultSelectionItemId ?? selectionItemIds[0] ?? null
  }, [autoSelectedItemIdRef, defaultSelectionItemId, selectionItemIds])
  return {
    listEntries,
    listEntryRenderKeys,
    selectableItems,
    selectionItemIds,
    selectionItemIdsRef,
    defaultSelectionItemId
  }
}

export type WorktreeJumpPaletteListEntries = ReturnType<typeof useWorktreeJumpPaletteListEntries>
