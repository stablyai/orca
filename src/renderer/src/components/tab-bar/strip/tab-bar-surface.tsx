import React from 'react'
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ProjectedAgentMenuItems } from '../../agent/launch-menu/AgentMenuItems'
import { OpenAgentSettingsMenuItem } from '../../agent/launch-menu/OpenAgentSettingsMenuItem'
import { TabBarAgentPickerEntry } from '../create-entry/TabBarAgentPickerEntry'
import { TabStripScrollIndicator } from './TabStripScrollIndicator'
import { TabStripTooltipProvider } from './TabStripTooltipProvider'
import { getTabStripScrollMaskClassName } from './tab-strip-scroll-metrics'
import type { useTabStripOverflowNavigation } from './tab-strip-overflow-navigation'
import type { useTabStripDragScrollHandlers } from './tab-strip-drag-scroll'
import type { TabBarProps } from '../tab-bar-props'
import type { TabBarRuntimeModel } from '../model/use-tab-bar-runtime-model'
import type { TabBarCreateMenuController } from '../create-menu/tab-bar-create-menu-contract'
import type { TabBarItemProjection } from '../model/use-tab-bar-item-projection'
import type { TabBarItemActions } from '../model/use-tab-bar-item-actions'
import { renderTabBarItems } from '../model/tab-bar-item-surface'
import { WindowedTabStrip } from './WindowedTabStrip'
import type { TabStripSegment } from './tab-strip-window'
import { TabBarStaticCreateMenu } from '../create-menu/tab-bar-static-create-menu'
import { NewTabMenuContent } from '../menu-fit/NewTabMenuContent'
import ClientHostedBrowserTabRows from '../browser-tabs/ClientHostedBrowserTabRows'
import { BotNewChatMenuItems } from '../../bots/BotNewChatMenuItems'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotGroup } from '../../../../../shared/bots/bot-group'
import { BotGroupNewThreadMenuItems } from '../../bots/BotGroupNewThreadMenuItems'
import type { ClientHostedBrowserRow } from '../../../../../shared/browser/client-hosting/client-hosted-browser-rows'
import { advanceAgentSessionsTourPastNewTab } from '@/components/contextual-tours/agent-sessions-tour-new-tab'
import { activateTabStripEntry } from './tab-strip-entry-activation'
import type { TabStripCondense } from './use-tab-strip-condense'
import { TabStripDensityContext } from './tab-strip-density-context'
import { PinnedHomeTabSlot } from './PinnedHomeTabSlot'
import {
  newTabButtonHideClassName,
  overflowChipActiveId,
  type RenderedTabStrip,
  stripSizeClassName
} from './rendered-tab-strip'
import { TabStripOverflowChip, type TabStripEntry } from './TabStripOverflowChip'

const EMPTY_CLIENT_HOSTED_ROWS: readonly ClientHostedBrowserRow[] = []
type Segments = readonly TabStripSegment[]

export function renderTabBarSurface(
  {
    props,
    runtime,
    createMenu,
    itemProjection,
    strip,
    tabStripNavigation,
    tabStripDragScroll,
    activeClientHostedBrowserRowId,
    itemActions,
    surfaceRef,
    bot,
    botGroup,
    condense,
    stripEntries,
    attentionIds
  }: {
    props: TabBarProps
    runtime: TabBarRuntimeModel
    createMenu: TabBarCreateMenuController
    itemProjection: TabBarItemProjection
    /** What renders: a pinned bot Home in its own slot, then the strip's tabs not behind +N. */
    strip: RenderedTabStrip
    tabStripNavigation: ReturnType<typeof useTabStripOverflowNavigation>
    tabStripDragScroll: ReturnType<typeof useTabStripDragScrollHandlers>
    activeClientHostedBrowserRowId: string | null
    itemActions: TabBarItemActions
    surfaceRef: (node: HTMLDivElement | null) => void
    /** Set in a bot's home, where the menu leads with a new chat with the bot. */
    bot: Bot | null
    /** Set in a group's home, where the menu leads with a new thread. */
    botGroup: BotGroup | null
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
    defaultWindowsPowerShellImplementation
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
  const { orderedItems: allItems, activeVisibleTabId } = itemProjection
  const allClientHostedBrowserRows = props.clientHostedBrowserRows ?? EMPTY_CLIENT_HOSTED_ROWS
  const { plan, hiddenIds, density, stripPointerHandlers } = condense
  const chipOnly = plan.mode === 'condensed' && plan.chipOnly
  const { orderedItems, sortableIds, dropIndicatorByVisibleId, clientHostedBrowserRows } = strip
  const { pinnedCount } = strip
  const {
    tabStripRef,
    tabStripOverflowState,
    activeTabDockSide,
    scrollTabStrip,
    subscribeToStripResize
  } = tabStripNavigation
  const singleTab = allItems.length + allClientHostedBrowserRows.length === 1
  const includeTopTabBorder = tabStripChrome !== 'floating-panel'
  const renderItems = (segments: Segments, itemOffset = pinnedCount): React.ReactNode[] =>
    renderTabBarItems({
      items: orderedItems,
      groupItems: allItems,
      props,
      runtime,
      actions: itemActions,
      dropIndicatorByVisibleId,
      includeTopTabBorder,
      activeClientHostedBrowserRowId,
      segments,
      itemOffset
    })

  return (
    <TabStripDensityContext value={density}>
      <div ref={surfaceRef} className="flex items-stretch h-full overflow-hidden flex-1 min-w-0">
        {pinnedCount > 0 ? (
          <PinnedHomeTabSlot
            sortableIds={strip.pinnedSortableIds}
            singleTab={singleTab}
            withStrip={strip.stripHasTabs}
            narrowHideClassName={strip.pinnedHomeNarrowHideClassName}
          >
            {renderItems([{ kind: 'tabs', start: 0, end: pinnedCount }], 0)}
          </PinnedHomeTabSlot>
        ) : null}
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
        <WindowedTabStrip
          stripRef={tabStripRef}
          subscribeToStripResize={subscribeToStripResize}
          sortableIds={sortableIds}
          activeVisibleTabId={activeVisibleTabId}
          renderStrip={(segments) => (
            // Why no-drag: tab interactions must work inside the titlebar's drag region (outer container stays window-draggable).
            <div
              data-single-tab={singleTab ? '' : undefined}
              // Why: tabs are the only drag source, so a narrow pane clips the "+" before the last tab sliver.
              className={`group/tab-strip relative flex min-h-0 w-max max-w-full ${stripSizeClassName(strip)}`}
              style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
              {...stripPointerHandlers}
            >
              <div
                ref={tabStripRef}
                // Tab drags clip drop targets to this box (tab-drag-collision.ts).
                data-tab-strip-scroller=""
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
                  {renderItems(segments)}
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
          )}
        />
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
            key={resolvedGroupId}
            entries={stripEntries}
            hiddenIds={hiddenIds}
            chipOnly={chipOnly}
            activeId={overflowChipActiveId(strip, plan)}
            attentionIds={attentionIds}
            generatedTabTitlesEnabled={runtime.generatedTabTitlesEnabled}
            isGroupFocused={isGroupFocused}
            worktreeId={worktreeId}
            groupId={resolvedGroupId}
            surface={condense.surface}
            onSelect={(entry) =>
              activateTabStripEntry({
                entry,
                worktreeId,
                groupId: resolvedGroupId,
                groupActiveTabId: props.groupActiveTabId ?? null,
                itemActions
              })
            }
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
              {/* Why: "+" hides whole rather than clip, so Tab never lands on it (rendered-tab-strip.ts). */}
              <button
                className={`ml-2 my-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground ${newTabButtonHideClassName(
                  strip,
                  hiddenIds.size > 0
                )}`}
                data-tab-strip-reserve=""
                style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
                title={t('auto.components.tab.bar.TabBar.b1a132357f', 'New tab')}
                aria-label={t('auto.components.tab.bar.TabBar.b1a132357f', 'New tab')}
                data-contextual-tour-target="tab-create-menu"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            </DropdownMenuTrigger>
            <NewTabMenuContent
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
                    excludedTabId={
                      activeClientHostedBrowserRowId === null
                        ? itemProjection.activeUnifiedTabId
                        : null
                    }
                    menuOpen={newTabMenuOpen}
                    menuOptions={createMenuOptions}
                    // A group's home offers its agents only through its thread, below; a bot's
                    // home searches its own chats in their place.
                    hideAgents={botGroup !== null}
                    botHome={bot && !terminalOnly ? { bot, agentMenu } : null}
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
                  {showStaticCreateMenuItems ? (
                    <DropdownMenuSeparator className="my-0 mb-1.5" />
                  ) : null}
                </>
              ) : null}
              {/* While a query is typed, the bot's chats are search results above instead. */}
              {bot && !terminalOnly && showStaticCreateMenuItems ? (
                <BotNewChatMenuItems bot={bot} model={agentMenu} />
              ) : null}
              {botGroup && !terminalOnly ? (
                <>
                  <BotGroupNewThreadMenuItems group={botGroup} />
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
                  queueNewActiveTerminalFocusAfterNewTabMenuClose={
                    queueNewActiveTerminalFocusAfterNewTabMenuClose
                  }
                />
              ) : null}
              {showStaticCreateMenuItems && showAgentLaunchItems && !botGroup ? (
                <>
                  <DropdownMenuSeparator />
                  {bot ? (
                    <OpenAgentSettingsMenuItem variant="create" />
                  ) : (
                    <ProjectedAgentMenuItems
                      model={agentMenu}
                      pickerInventory={agentPickerInventory}
                      onSelectPickerAgent={selectPickerAgent}
                      hidePickerSearch={!terminalOnly && Boolean(onOpenEntry)}
                      runLaunch={launchAgentRow}
                    />
                  )}
                </>
              ) : null}
            </NewTabMenuContent>
          </DropdownMenu>
        )}
      </div>
    </TabStripDensityContext>
  )
}
