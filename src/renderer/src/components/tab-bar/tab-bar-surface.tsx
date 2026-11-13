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
    surfaceRef
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
  },
  t: Translate = translate
): React.JSX.Element {
  const {
    worktreeId,
    terminalOnly = false,
    showAgentLaunchItems = true,
    onNewTerminalTab,
    onOpenEntry,
    tabStripChrome = 'default'
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
  const { orderedItems, sortableIds, dropIndicatorByVisibleId } = itemProjection
  const clientHostedBrowserRows = props.clientHostedBrowserRows ?? EMPTY_CLIENT_HOSTED_ROWS
  const {
    tabStripRef,
    tabStripOverflowState,
    activeTabDockSide,
    scrollTabStrip,
    subscribeToStripResize
  } = tabStripNavigation
  const singleTab = orderedItems.length + clientHostedBrowserRows.length === 1
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
    <div ref={surfaceRef} className="flex items-stretch h-full overflow-hidden flex-1 min-w-0">
      {tabStripOverflowState.hasOverflow ? (
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
      {tabStripOverflowState.hasOverflow ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              className="mx-0.5 my-auto h-6 w-5 @max-[260px]/tab-strip:hidden"
              style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
              aria-label={t('auto.components.tab.bar.TabBar.232e075b07', 'Scroll tabs right')}
              aria-disabled={!tabStripOverflowState.canScrollEnd}
              disabled={!tabStripDragScroll.isTabDragActive && !tabStripOverflowState.canScrollEnd}
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
              hasTabs ? '@max-[86px]/tab-strip:hidden' : ''
            }`}
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
    </div>
  )
}
