import { Fragment, type ComponentType, type JSX } from 'react'
import { useAppStore } from '@/store'
import {
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { OptionChoiceSubmenu } from './OptionChoiceSubmenu'
import SidebarRepositoryFilterSection from './SidebarRepositoryFilterSection'
import { WorkspaceFilterOptionRow } from './workspace-filter-option-row'
import {
  getSidebarHostVisibilityLabel,
  shouldShowHostScopeControls,
  type SidebarHostOption
} from './sidebar-host-options'
import { useSidebarHostScopeOptions } from './use-sidebar-host-scope-options'
import { SidebarHostScopeMenuSection } from './SidebarHostScopeMenuSection'
import { PROJECT_ORDER_OPTIONS, SORT_OPTIONS } from './sidebar-workspace-option-items'
import {
  WorktreeCardDisplayMenuItem,
  WorktreeCardLayoutMenuItem,
  WorktreeCardPropertiesMenuItem
} from '../../workspace-card/surface/worktree-card-option-items'
import {
  getShownWorkspaceViewSections,
  type WorkspaceViewOptionKey,
  type WorkspaceViewSection
} from '../../../../../../shared/workspace-view/workspace-view-options'
import { useTranslate } from '@/i18n/use-translate'
import { SidebarGroupByToggle } from './SidebarGroupByToggle'
import { HideBotCreatedFilterRow } from '@/components/bots/HideBotCreatedFilterRow'
import { selectDrawsNewWorktreeCards } from '@/store/appearance/worktree-card-style'
import { trackWorktreeCardStyleChanged } from '../../workspace-card/template/worktree-card-style-telemetry'

const getAppStoreState = (): ReturnType<typeof useAppStore.getState> => useAppStore.getState()

type OptionItemProps = {
  preserveWorkspaceBoardOpen: boolean
  hostOptions: SidebarHostOption[]
}

function CardStyleOption({ preserveWorkspaceBoardOpen }: OptionItemProps): JSX.Element {
  const t = useTranslate()
  const experimental = useAppStore((s) => s.settings?.experimentalNewWorktreeCardStyle === true)
  const { updateSettings } = getAppStoreState()
  const classicLabel = t(
    'auto.components.settings.ExperimentalPane.worktreeCardStyle.classic',
    'Classic'
  )
  const experimentalLabel = t(
    'auto.components.settings.ExperimentalPane.worktreeCardStyle.experimental',
    'Experimental'
  )
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <span className="flex flex-1 items-center justify-between gap-3">
          <span>
            {t('auto.components.settings.ExperimentalPane.worktreeCardStyle.title', 'Card style')}
          </span>
          <span className="text-2xs font-medium text-muted-foreground">
            {experimental ? experimentalLabel : classicLabel}
          </span>
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent
        className="w-44"
        data-workspace-board-preserve-open={preserveWorkspaceBoardOpen ? '' : undefined}
      >
        <DropdownMenuRadioGroup
          value={experimental ? 'experimental' : 'classic'}
          onValueChange={(value) => {
            const next = value === 'experimental'
            void updateSettings({ experimentalNewWorktreeCardStyle: next }).then(() => {
              const state = useAppStore.getState()
              if ((state.settings?.experimentalNewWorktreeCardStyle === true) !== next) {
                return
              }
              state.setWorktreeCardsIntroChoice(null)
              if (next !== experimental) {
                trackWorktreeCardStyleChanged(next, 'options_menu')
              }
            })
          }}
        >
          <DropdownMenuRadioItem value="classic">{classicLabel}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="experimental">{experimentalLabel}</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

function HostsOptionItem({
  preserveWorkspaceBoardOpen,
  hostOptions
}: OptionItemProps): JSX.Element {
  const t = useTranslate()
  const visibleWorkspaceHostIds = useAppStore((s) => s.visibleWorkspaceHostIds)
  const { setWorkspaceHostScope, setVisibleWorkspaceHostIds } = getAppStoreState()
  return (
    <SidebarHostScopeMenuSection
      hostVisibilityLabel={getSidebarHostVisibilityLabel(visibleWorkspaceHostIds, hostOptions, t)}
      hostOptions={hostOptions}
      preserveWorkspaceBoardOpen={preserveWorkspaceBoardOpen}
      setWorkspaceHostScope={setWorkspaceHostScope}
      visibleWorkspaceHostIds={visibleWorkspaceHostIds}
      setVisibleWorkspaceHostIds={setVisibleWorkspaceHostIds}
    />
  )
}

function GroupByOptionItem(): JSX.Element {
  const groupBy = useAppStore((s) => s.groupBy)
  const { setGroupBy } = getAppStoreState()
  return (
    <div className="px-2 pt-0.5 pb-1">
      <SidebarGroupByToggle groupBy={groupBy} setGroupBy={setGroupBy} />
    </div>
  )
}

function SortByOptionItem({ preserveWorkspaceBoardOpen }: OptionItemProps): JSX.Element {
  const t = useTranslate()
  const sortBy = useAppStore((s) => s.sortBy)
  const { setSortBy } = getAppStoreState()
  return (
    <OptionChoiceSubmenu
      label={t('auto.components.sidebar.SidebarWorkspaceOptionsMenu.7bada3b1ab', 'Sort by')}
      choices={SORT_OPTIONS}
      value={sortBy}
      onChange={setSortBy}
      preserveWorkspaceBoardOpen={preserveWorkspaceBoardOpen}
    />
  )
}

function ProjectOrderOptionItem({ preserveWorkspaceBoardOpen }: OptionItemProps): JSX.Element {
  const t = useTranslate()
  const projectOrderBy = useAppStore((s) => s.projectOrderBy)
  const { setProjectOrderBy } = getAppStoreState()
  return (
    <OptionChoiceSubmenu
      label={t('auto.components.sidebar.SidebarWorkspaceOptionsMenu.09faabd875', 'Project order')}
      choices={PROJECT_ORDER_OPTIONS}
      value={projectOrderBy}
      onChange={setProjectOrderBy}
      preserveWorkspaceBoardOpen={preserveWorkspaceBoardOpen}
    />
  )
}

/** One desktop control per shared option; a new option fails to compile until it has one. */
const OPTION_ITEMS: Record<WorkspaceViewOptionKey, ComponentType<OptionItemProps>> = {
  hosts: HostsOptionItem,
  projects: SidebarRepositoryFilterSection,
  groupBy: GroupByOptionItem,
  sortBy: SortByOptionItem,
  projectOrderBy: ProjectOrderOptionItem,
  cardLayout: WorktreeCardLayoutMenuItem,
  cardProperties: WorktreeCardPropertiesMenuItem,
  cardDisplay: WorktreeCardDisplayMenuItem,
  hideSleepingWorkspaces: () => <WorkspaceFilterOptionRow optionKey="hideSleepingWorkspaces" />,
  alwaysShowDefaultBranchWorkspace: () => (
    <WorkspaceFilterOptionRow optionKey="alwaysShowDefaultBranchWorkspace" />
  ),
  hideDefaultBranchWorkspace: () => (
    <WorkspaceFilterOptionRow optionKey="hideDefaultBranchWorkspace" />
  ),
  hideAutomationGeneratedWorkspaces: () => (
    <WorkspaceFilterOptionRow optionKey="hideAutomationGeneratedWorkspaces" />
  ),
  hideCliCreatedWorkspaces: () => <WorkspaceFilterOptionRow optionKey="hideCliCreatedWorkspaces" />,
  hideWorkspacesFromOtherDevices: () => (
    <WorkspaceFilterOptionRow optionKey="hideWorkspacesFromOtherDevices" />
  ),
  hideDetachedHeadWorkspaces: () => (
    <WorkspaceFilterOptionRow optionKey="hideDetachedHeadWorkspaces" />
  )
}

function SectionHeading({ section }: { section: WorkspaceViewSection }): JSX.Element | null {
  const t = useTranslate()
  switch (section) {
    case 'show':
      return (
        <DropdownMenuLabel>
          {t('auto.components.sidebar.SidebarWorkspaceOptionsMenu.selectionSection', 'Selection')}
        </DropdownMenuLabel>
      )
    case 'group':
      return (
        <DropdownMenuLabel>
          {t('auto.components.sidebar.SidebarWorkspaceOptionsMenu.dc0bb670bc', 'Group by')}
        </DropdownMenuLabel>
      )
    case 'arrange':
      return null
    case 'filters':
      return (
        <div className="flex items-center justify-between px-2 py-1">
          <span className="text-[11px] font-semibold text-muted-foreground">
            {t('auto.components.sidebar.SidebarWorkspaceFilterSection.82594419ba', 'Filters')}
          </span>
        </div>
      )
  }
}

export function WorkspaceOptionsMenuItems({
  preserveWorkspaceBoardOpen = false
}: {
  preserveWorkspaceBoardOpen?: boolean
}): JSX.Element {
  const repoCount = useAppStore((s) => s.repos.length)
  const groupBy = useAppStore((s) => s.groupBy)
  const showSleepingWorkspaces = useAppStore((s) => s.showSleepingWorkspaces)
  const hideWorkspacesFromOtherDevices = useAppStore((s) => s.hideWorkspacesFromOtherDevices)
  const newCardStyle = useAppStore(selectDrawsNewWorktreeCards)
  const runtimeEnvironmentCount = useAppStore((s) => s.runtimeEnvironments.length)
  const runtimeEnvironmentCatalogHydrated = useAppStore((s) => s.runtimeEnvironmentCatalogHydrated)
  const { hostOptions } = useSidebarHostScopeOptions()
  const sections = getShownWorkspaceViewSections({
    groupBy,
    hideSleepingWorkspaces: !showSleepingWorkspaces,
    hideWorkspacesFromOtherDevices,
    newCardStyle,
    hasRemoteHosts: shouldShowHostScopeControls(hostOptions),
    projectCount: repoCount,
    mayHaveServerHosts: !runtimeEnvironmentCatalogHydrated || runtimeEnvironmentCount > 0
  })

  return (
    <>
      {sections.map(({ section, options }, index) => (
        <Fragment key={section}>
          {index > 0 && <DropdownMenuSeparator />}
          <SectionHeading section={section} />
          {options.map((option) => {
            const OptionItem = OPTION_ITEMS[option.key]
            return (
              <Fragment key={option.key}>
                {(option.key === 'cardLayout' || option.key === 'cardDisplay') && (
                  <CardStyleOption
                    preserveWorkspaceBoardOpen={preserveWorkspaceBoardOpen}
                    hostOptions={hostOptions}
                  />
                )}
                <OptionItem
                  preserveWorkspaceBoardOpen={preserveWorkspaceBoardOpen}
                  hostOptions={hostOptions}
                />
              </Fragment>
            )
          })}
          {/* Desktop-only: bots live on this computer, so it stays out of the shared option list. */}
          {section === 'filters' && <HideBotCreatedFilterRow />}
        </Fragment>
      ))}
    </>
  )
}
