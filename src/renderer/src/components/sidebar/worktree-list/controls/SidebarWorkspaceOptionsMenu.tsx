import React, { Suspense } from 'react'
import { lazyWithRetry as lazy } from '@/app-shell/startup/lazy-with-retry'
import { useTranslate } from '@/i18n/use-translate'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { useAppStore } from '@/store/index'
import { SidebarOptionsPopover } from './SidebarOptionsPopover'
import { useWorkspaceOptionsFilterBadge } from './use-workspace-options-filter-badge'

const WorkspaceOptionsMenuItems = lazy(() =>
  import('./workspace-options-menu-items').then((module) => ({
    default: module.WorkspaceOptionsMenuItems
  }))
)

const LazyWorktreeCardsKeptHintContent = lazy(
  () =>
    import('../../workspace-card/template/WorktreeCardsIntroNotice').then((module) => ({
      default: module.WorktreeCardsKeptHintContent
    })),
  { reloadKey: 'worktree-cards-kept-hint-content' }
)

const dismissKeptHint = (): void => useAppStore.getState().setWorktreeCardsIntroKeptHintOpen(false)

type SidebarWorkspaceOptionsMenuProps = {
  preserveWorkspaceBoardOpen?: boolean
  onMenuOpenChange?: (open: boolean) => void
}

const SidebarWorkspaceOptionsMenu = React.memo(function SidebarWorkspaceOptionsMenu({
  preserveWorkspaceBoardOpen = false,
  onMenuOpenChange
}: SidebarWorkspaceOptionsMenuProps) {
  const t = useTranslate()
  useUiLanguageRevision()
  const { hasAnyFilter, activeFilterCount } = useWorkspaceOptionsFilterBadge()
  const keptHintOpen = useAppStore((s) => s.worktreeCardsIntroKeptHintOpen)

  return (
    <SidebarOptionsPopover
      ariaLabel={
        hasAnyFilter
          ? t(
              'auto.components.sidebar.SidebarWorkspaceOptionsMenu.optionsActiveFilters',
              'Workspace options ({{count}} filters active)',
              {
                count: activeFilterCount,
                defaultValue_one: 'Workspace options ({{count}} filter active)'
              }
            )
          : t('auto.components.sidebar.SidebarWorkspaceOptionsMenu.9919ae1082', 'Workspace options')
      }
      tooltip={
        hasAnyFilter
          ? t(
              'auto.components.sidebar.SidebarWorkspaceOptionsMenu.optionsFilterCount',
              'Workspace options ({{count}} filters)',
              {
                count: activeFilterCount,
                defaultValue_one: 'Workspace options ({{count}} filter)'
              }
            )
          : t('auto.components.sidebar.SidebarWorkspaceOptionsMenu.9919ae1082', 'Workspace options')
      }
      activeFilterCount={activeFilterCount}
      preserveWorkspaceBoardOpen={preserveWorkspaceBoardOpen}
      onMenuOpenChange={onMenuOpenChange}
      hint={{
        open: keptHintOpen,
        onDismiss: dismissKeptHint,
        content: keptHintOpen ? (
          <Suspense fallback={null}>
            <LazyWorktreeCardsKeptHintContent />
          </Suspense>
        ) : null
      }}
    >
      <Suspense fallback={null}>
        <WorkspaceOptionsMenuItems preserveWorkspaceBoardOpen={preserveWorkspaceBoardOpen} />
      </Suspense>
    </SidebarOptionsPopover>
  )
})

export default SidebarWorkspaceOptionsMenu
