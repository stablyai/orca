import type React from 'react'
import {
  DropdownMenu,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { ProjectedAgentMenuItems } from '../../agent/launch-menu/AgentMenuItems'
import { OpenAgentSettingsMenuItem } from '../../agent/launch-menu/OpenAgentSettingsMenuItem'
import { TabBarAgentPickerEntry } from '../create-entry/TabBarAgentPickerEntry'
import type { TabBarProps } from '../tab-bar-props'
import type { TabBarRuntimeModel } from '../model/use-tab-bar-runtime-model'
import type { TabBarCreateMenuController } from './tab-bar-create-menu-contract'
import { TabBarStaticCreateMenu } from './tab-bar-static-create-menu'
import { NewTabMenuContent } from '../menu-fit/NewTabMenuContent'
import { BotNewChatMenuItems } from '../../bots/BotNewChatMenuItems'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotGroup } from '../../../../../shared/bots/bot-group'
import { BotGroupNewThreadMenuItems } from '../../bots/BotGroupNewThreadMenuItems'
import { advanceAgentSessionsTourPastNewTab } from '@/components/contextual-tours/agent-sessions-tour-new-tab'

/** The "+" menu, shared by the top strip and the left vertical tab list; `children` is its trigger. */
export function TabBarNewTabMenu({
  props,
  runtime,
  createMenu,
  excludedTabId,
  bot,
  botGroup,
  align,
  side,
  children
}: {
  props: TabBarProps
  runtime: TabBarRuntimeModel
  createMenu: TabBarCreateMenuController
  /** The tab a picker search should not offer to switch to: the one already showing. */
  excludedTabId: string | null
  /** Set in a bot's home, where the menu leads with a new chat with the bot. */
  bot: Bot | null
  /** Set in a group's home, where the menu leads with a new thread. */
  botGroup: BotGroup | null
  align: 'start' | 'end'
  side?: 'bottom' | 'right'
  children: React.ReactElement
}): React.JSX.Element {
  const { worktreeId, terminalOnly = false, showAgentLaunchItems = true, onOpenEntry } = props
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
    <DropdownMenu
      open={newTabMenuOpen}
      onOpenChange={setNewTabMenuOpen}
      // Why: modal would disable body pointer events, making the Mobile Emulator "Hide" re-enable toast unclickable.
      modal={false}
    >
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <NewTabMenuContent
        align={align}
        side={side}
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
              excludedTabId={excludedTabId}
              menuOpen={newTabMenuOpen}
              menuOptions={createMenuOptions}
              // A group's home offers its agents only through its thread, below; a bot's
              // home searches its own chats in their place.
              hideAgents={botGroup !== null}
              botHome={bot && !terminalOnly ? { bot, agentMenu } : null}
              onLaunchAgentOption={launchAgentFromNewTabEntry}
              onOpenDefaultTerminal={() => {
                queueNewActiveTerminalFocusAfterNewTabMenuClose()
                props.onNewTerminalTab()
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
    </DropdownMenu>
  )
}
