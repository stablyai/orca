import React from 'react'
import { DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { ProjectedAgentMenuItems } from '../../agent/launch-menu/AgentMenuItems'
import { OpenAgentSettingsMenuItem } from '../../agent/launch-menu/OpenAgentSettingsMenuItem'
import { TabBarAgentPickerEntry } from '../create-entry/TabBarAgentPickerEntry'
import type { TabBarProps } from '../tab-bar-props'
import type { TabBarRuntimeModel } from '../model/use-tab-bar-runtime-model'
import type { TabBarCreateMenuController } from './tab-bar-create-menu-contract'
import type { TabBarItemProjection } from '../model/use-tab-bar-item-projection'
import { TabBarStaticCreateMenu } from './tab-bar-static-create-menu'
import { NewTabMenuContent } from '../menu-fit/NewTabMenuContent'
import { BotNewChatMenuItems } from '../../bots/BotNewChatMenuItems'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotGroup } from '../../../../../shared/bots/bot-group'
import { BotGroupNewThreadMenuItems } from '../../bots/BotGroupNewThreadMenuItems'
import { advanceAgentSessionsTourPastNewTab } from '@/components/contextual-tours/agent-sessions-tour-new-tab'

export type TabBarNewTabMenuContentProps = {
  props: TabBarProps
  runtime: TabBarRuntimeModel
  createMenu: TabBarCreateMenuController
  itemProjection: TabBarItemProjection
  activeClientHostedBrowserRowId: string | null
  bot: Bot | null
  botGroup: BotGroup | null
}

export function TabBarNewTabMenuContent({
  props,
  runtime,
  createMenu,
  itemProjection,
  activeClientHostedBrowserRowId,
  bot,
  botGroup
}: TabBarNewTabMenuContentProps): React.JSX.Element {
  const {
    worktreeId,
    terminalOnly = false,
    showAgentLaunchItems = true,
    onNewTerminalTab,
    onOpenEntry
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

  return (
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
              activeClientHostedBrowserRowId === null ? itemProjection.activeUnifiedTabId : null
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
          {showStaticCreateMenuItems ? <DropdownMenuSeparator className="my-0 mb-1.5" /> : null}
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
  )
}
