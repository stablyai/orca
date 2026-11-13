import React from 'react'
import { SortableContext } from '@dnd-kit/sortable'
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ProjectedAgentMenuItems } from './QuickLaunchButton'
import { TabBarAgentPickerEntry } from './TabBarAgentPickerEntry'
import { TabStripScrollIndicator } from './TabStripScrollIndicator'
import { TabStripTooltipProvider } from './TabStripTooltipProvider'
import { getTabStripScrollMaskClassName } from './tab-strip-scroll-metrics'
import type { useTabStripOverflowNavigation } from './tab-strip-overflow-navigation'
import type { useTabStripDragScrollHandlers } from './tab-strip-drag-scroll'
import type { TabBarProps } from './tab-bar-props'
import type { TabBarRuntimeModel } from './use-tab-bar-runtime-model'
import type { TabBarCreateMenuController } from './use-tab-bar-create-menu-controller'
import type { TabBarItemProjection } from './use-tab-bar-item-projection'
import type { TabBarItemActions } from './use-tab-bar-item-actions'
import { renderTabBarItems } from './tab-bar-item-surface'
import { TabBarStaticCreateMenu } from './tab-bar-static-create-menu'
import ClientHostedBrowserTabRows from './ClientHostedBrowserTabRows'
import type { ClientHostedBrowserRow } from '../../../../shared/client-hosted-browser-rows'
import { advanceAgentSessionsTourPastNewTab } from '@/components/contextual-tours/agent-sessions-tour-new-tab'
import { useAppStore } from '../../store'
import { selectClientHostedBrowserRow } from '@/runtime/browser/client-hosting/client-hosted-browser-row-state'
import { buildTabDropIndicators } from './tab-bar-item-model'
import type { TabStripCondense } from './use-tab-strip-condense'
import { TabStripDensityContext } from './tab-strip-density-context'
import { TabStripOverflowChip, type TabStripEntry } from './TabStripOverflowChip'

const EMPTY_CLIENT_HOSTED_ROWS: readonly ClientHostedBrowserRow[] = []

export function renderTabBarSurface(
  {
    props,
    runtime,
    createMenu,
    itemProjection,
    tabStripNavigation,
    tabStripDragScroll,
    activeClientHostedBrowserRowId,
    itemActions,
    surfaceRef,
    condense,
    stripEntries,
    attentionIds
  }: {
    props: TabBarProps
    runtime: TabBarRuntimeModel
    createMenu: TabBarCreateMenuController
    itemProjection: TabBarItemProjection
    tabStripNavigation: ReturnType<typeof useTabStripOverflowNavigation>
    tabStripDragScroll: ReturnType<typeof useTabStripDragScrollHandlers>
    activeClientHostedBrowserRowId: string | null
    itemActions: TabBarItemActions
    surfaceRef: (node: HTMLDivElement | null) => void
    condense: TabStripCondense
    stripEntries: readonly TabStripEntry[]
    attentionIds: ReadonlySet<string>
  },
  t: Translate = translate
): React.JSX.Element {
  const {
    worktreeId,
    terminalOnly = false,
    showAgentLaunchItems = true,
    onNewTerminalTab,
    onOpenEntry,
    tabStripChrome = 'default',
    newTabButtonFolded = false,
    isGroupFocused = false
  } = props
  const {
    resolvedGroupId,
    mobileEmulatorEnabled,
    managedBrowserCreationEnabled,
    mobileEmulatorCreationEnabled,
    workspaceHasSimulatorTab,
    showMobileEmulatorIntroCallout,
    windowsTerminalCapabilities,
    defaultWindowsPowerShellImplementation,
    newTerminalShortcut,
    newBrowserShortcut,
    newSimulatorShortcut,
    newFileShortcut,
    openMarkdownShortcut
  } = runtime
  const {
    agentMenu,
    agentPickerInventory,
    selectPickerAgent,
    launchAgentRow,
    newTabMenuOpen,
    setNewTabMenuOpen,
    setCreateMenuQuery,
    createMenuOptions,
    windowsShellEntries,
    handleSelectCreateMenuOption,
    launchAgentFromNewTabEntry,
    runPendingNewTabMenuFocusAfterClose,
    queueNewActiveTerminalFocusAfterNewTabMenuClose,
    queueFocusAfterNewTabMenuClose,
    showStaticCreateMenuItems
  } = createMenu
  const { orderedItems: allItems, sortableIds: allSortableIds } = itemProjection
  const allClientHostedBrowserRows = props.clientHostedBrowserRows ?? EMPTY_CLIENT_HOSTED_ROWS
  const { plan, hiddenIds, density, stripPointerHandlers } = condense
  const chipOnly = plan.mode === 'condensed' && plan.chipOnly
  // Hidden tabs are not rendered, so dnd-kit and the drop bar work over the rendered sequence only.
  const orderedItems =
    hiddenIds.size === 0 ? allItems : allItems.filter((item) => !hiddenIds.has(item.id))
  const sortableIds =
    hiddenIds.size === 0 ? allSortableIds : allSortableIds.filter((id) => !hiddenIds.has(id))
  const dropIndicatorByVisibleId =
    hiddenIds.size === 0
      ? itemProjection.dropIndicatorByVisibleId
      : buildTabDropIndicators(orderedItems, itemProjection.hoveredInsertion)
  const clientHostedBrowserRows =
    hiddenIds.size === 0
      ? allClientHostedBrowserRows
      : allClientHostedBrowserRows.filter((row) => !hiddenIds.has(row.browserPageId))
  const activateEntry = (entry: TabStripEntry): void => {
    if (entry.kind === 'paired') {
      useAppStore.getState().focusGroup(worktreeId, resolvedGroupId)
      selectClientHostedBrowserRow({
        worktreeId,
        browserPageId: entry.row.browserPageId,
        groupId: resolvedGroupId,
        groupActiveTabIdAtSelection: props.groupActiveTabId ?? null
      })
      return
    }
    const { item } = entry
    if (item.type === 'terminal') {
      itemActions.activateTerminal(item.id)
    } else if (item.type === 'browser') {
      itemActions.activateBrowserTab(item.id)
    } else if (item.type === 'agent-session') {
      itemActions.activateAgentSession(item.id)
    } else {
      itemActions.activateFile(item.id)
    }
  }
  const {
    tabStripRef,
    tabStripOverflowState,
    activeTabDockSide,
    scrollTabStrip,
    subscribeToStripResize
  } = tabStripNavigation
  const singleTab = allItems.length + allClientHostedBrowserRows.length === 1
  const includeTopTabBorder = tabStripChrome !== 'floating-panel'
  const renderedItems = renderTabBarItems({
    items: orderedItems,
    props,
    runtime,
    actions: itemActions,
    dropIndicatorByVisibleId,
    includeTopTabBorder,
    activeClientHostedBrowserRowId
  })

  const hasTabs = orderedItems.length + clientHostedBrowserRows.length > 0
  return (
    <TabStripDensityContext value={density}>
      <div ref={surfaceRef} className="flex items-stretch h-full overflow-hidden flex-1 min-w-0">
        {condense.showScrollArrows ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                className="mx-0.5 my-auto h-6 w-5 @max-[260px]/tab-strip:hidden"
                style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
                aria-label={t('auto.components.tab.bar.TabBar.7a9b4af2af', 'Scroll tabs left')}
                aria-disabled={!tabStripOverflowState.canScrollStart}
                disabled={
                  !tabStripDragScroll.isTabDragActive && !tabStripOverflowState.canScrollStart
                }
                onClick={() => scrollTabStrip('start')}
                onPointerEnter={tabStripDragScroll.onDragScrollStartEnter}
                onPointerLeave={tabStripDragScroll.onDragScrollLeave}
              >
                <ChevronLeft className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {t('auto.components.tab.bar.TabBar.7a9b4af2af', 'Scroll tabs left')}
            </TooltipContent>
          </Tooltip>
        ) : null}
        {/* Keep drag siblings anchored; only the insertion bar moves. */}
        <SortableContext items={sortableIds}>
          {/* Why: no-drag lets tab interactions work inside the titlebar's drag region (outer container stays window-draggable). */}
          <div
            data-single-tab={singleTab ? '' : undefined}
            // Why: tabs are the only drag source, so a narrow pane clips the "+" before the last tab sliver.
            className={`group/tab-strip relative flex min-h-0 w-max max-w-full shrink ${
              hasTabs ? 'min-w-10' : 'min-w-0'
            }`}
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            {...stripPointerHandlers}
          >
            <div
              ref={tabStripRef}
              data-active-tab-docked={activeTabDockSide ?? undefined}
              // Why: only `border-r` here — a strip-level `border-l` would render a heavier L-corner than the first tab's own `border-l`.
              className={[
                'terminal-tab-strip flex h-full min-w-0 max-w-full flex-1 items-stretch overflow-x-auto overflow-y-hidden',
                'border-r border-border/70',
                getTabStripScrollMaskClassName(tabStripOverflowState, activeTabDockSide)
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <TabStripTooltipProvider>
                {renderedItems}
                {clientHostedBrowserRows.length > 0 ? (
                  <ClientHostedBrowserTabRows
                    rows={clientHostedBrowserRows}
                    worktreeId={worktreeId}
                    groupId={resolvedGroupId}
                    groupActiveTabId={props.groupActiveTabId ?? null}
                    includeTopTabBorder={includeTopTabBorder}
                  />
                ) : null}
              </TabStripTooltipProvider>
            </div>
            <TabStripScrollIndicator
              hasOverflow={tabStripOverflowState.hasOverflow}
              scrollContainerRef={tabStripRef}
              subscribeToStripResize={subscribeToStripResize}
              disabled={tabStripDragScroll.isTabDragActive}
            />
          </div>
        </SortableContext>
        {condense.showScrollArrows ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                className="mx-0.5 my-auto h-6 w-5 @max-[260px]/tab-strip:hidden"
                style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
                aria-label={t('auto.components.tab.bar.TabBar.232e075b07', 'Scroll tabs right')}
                aria-disabled={!tabStripOverflowState.canScrollEnd}
                disabled={
                  !tabStripDragScroll.isTabDragActive && !tabStripOverflowState.canScrollEnd
                }
                onClick={() => scrollTabStrip('end')}
                onPointerEnter={tabStripDragScroll.onDragScrollEndEnter}
                onPointerLeave={tabStripDragScroll.onDragScrollLeave}
              >
                <ChevronRight className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {t('auto.components.tab.bar.TabBar.232e075b07', 'Scroll tabs right')}
            </TooltipContent>
          </Tooltip>
        ) : null}
        {hiddenIds.size > 0 ? (
          <TabStripOverflowChip
            entries={stripEntries}
            hiddenIds={hiddenIds}
            chipOnly={chipOnly}
            activeId={plan.mode === 'condensed' ? plan.activeId : null}
            attentionIds={attentionIds}
            generatedTabTitlesEnabled={runtime.generatedTabTitlesEnabled}
            isGroupFocused={isGroupFocused}
            surface={condense.surface}
            onSelect={activateEntry}
          />
        ) : null}
        {newTabButtonFolded ? null : (
          <DropdownMenu
            open={newTabMenuOpen}
            onOpenChange={setNewTabMenuOpen}
            // Why: modal would disable body pointer events, making the Mobile Emulator "Hide" re-enable toast unclickable.
            modal={false}
          >
            <DropdownMenuTrigger asChild>
              {/* Why: below 86px (40 tab floor + 36 "+" + 8 action padding + 2 sub-pixel slack) "+" would only clip; hide it whole so Tab never lands on it. Empty groups keep it. */}
              <button
                className={`ml-2 my-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground ${
                  hasTabs || hiddenIds.size > 0 ? '@max-[86px]/tab-strip:hidden' : ''
                }`}
                data-tab-strip-reserve=""
                style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
                title={t('auto.components.tab.bar.TabBar.b1a132357f', 'New tab')}
                aria-label={t('auto.components.tab.bar.TabBar.b1a132357f', 'New tab')}
                data-contextual-tour-target="tab-create-menu"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              sideOffset={6}
              className="w-72 max-w-[calc(100vw-1rem)] rounded-[11px] border-border/80 p-1 shadow-[0_16px_36px_rgba(0,0,0,0.24)]"
              onCloseAutoFocus={(event) => {
                // Why: Radix restores focus to the "+" trigger on close, stealing it from the freshly-mounted terminal.
                event.preventDefault()
                runPendingNewTabMenuFocusAfterClose()
                advanceAgentSessionsTourPastNewTab()
              }}
            >
              {!terminalOnly && onOpenEntry ? (
                <>
                  <TabBarAgentPickerEntry
                    inventory={agentPickerInventory}
                    terminalPending={agentMenu.state === 'settled' && agentMenu.terminalPending}
                    worktreeId={worktreeId}
                    groupId={resolvedGroupId}
                    menuOpen={newTabMenuOpen}
                    menuOptions={createMenuOptions}
                    onLaunchAgentOption={launchAgentFromNewTabEntry}
                    onOpenDefaultTerminal={() => {
                      queueNewActiveTerminalFocusAfterNewTabMenuClose()
                      onNewTerminalTab()
                    }}
                    onOpenEntry={onOpenEntry}
                    onQueryChange={setCreateMenuQuery}
                    onQueueSwitchFocus={queueFocusAfterNewTabMenuClose}
                    onSelectMenuOption={handleSelectCreateMenuOption}
                    onDidOpenEntry={() => setNewTabMenuOpen(false)}
                  />
                  {showStaticCreateMenuItems ? <DropdownMenuSeparator /> : null}
                </>
              ) : null}
              {showStaticCreateMenuItems ? (
                <TabBarStaticCreateMenu
                  props={props}
                  groupId={resolvedGroupId}
                  terminalOnly={terminalOnly}
                  mobileEmulatorEnabled={mobileEmulatorEnabled}
                  managedBrowserCreationEnabled={managedBrowserCreationEnabled}
                  mobileEmulatorCreationEnabled={mobileEmulatorCreationEnabled}
                  workspaceHasSimulatorTab={workspaceHasSimulatorTab}
                  showMobileEmulatorIntroCallout={showMobileEmulatorIntroCallout}
                  windowsShellEntries={windowsShellEntries}
                  defaultWindowsPowerShellImplementation={defaultWindowsPowerShellImplementation}
                  pwshAvailable={windowsTerminalCapabilities.pwshAvailable}
                  newTerminalShortcut={newTerminalShortcut}
                  newBrowserShortcut={newBrowserShortcut}
                  newSimulatorShortcut={newSimulatorShortcut}
                  newFileShortcut={newFileShortcut}
                  openMarkdownShortcut={openMarkdownShortcut}
                  queueNewActiveTerminalFocusAfterNewTabMenuClose={
                    queueNewActiveTerminalFocusAfterNewTabMenuClose
                  }
                />
              ) : null}
              {showStaticCreateMenuItems && showAgentLaunchItems ? (
                <>
                  <DropdownMenuSeparator />
                  <ProjectedAgentMenuItems
                    model={agentMenu}
                    pickerInventory={agentPickerInventory}
                    onSelectPickerAgent={selectPickerAgent}
                    hidePickerSearch={!terminalOnly && Boolean(onOpenEntry)}
                    runLaunch={launchAgentRow}
                  />
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </TabStripDensityContext>
  )
}
