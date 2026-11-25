import { BotNewChatMenuItems } from '../bots/BotNewChatMenuItems'
import { BotGroupNewThreadMenuItems } from '../bots/BotGroupNewThreadMenuItems'
import { useBotForWorkspace, useBotGroupForWorkspace } from '../bots/bot-workspace'
import { OpenAgentSettingsMenuItem } from '../agent/launch-menu/OpenAgentSettingsMenuItem'
import type { Bot } from '../../../../shared/bot-types'
import type { BotGroup } from '../../../../shared/bots/bot-group'
import React from 'react'
import type { usePluginNewFiles } from '@/store/plugins/file-creation/plugin-new-files'
import { Plus } from 'lucide-react'
import { NewTabMenuContent } from './menu-fit/NewTabMenuContent'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import {
  DropdownMenu,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { ProjectedAgentMenuItems } from '../agent/launch-menu/AgentMenuItems'
import { TabBarAgentPickerEntry } from './create-entry/TabBarAgentPickerEntry'
import { TabBarStaticCreateMenu } from './create-menu/tab-bar-static-create-menu'
import { advanceAgentSessionsTourPastNewTab } from '@/components/contextual-tours/agent-sessions-tour-new-tab'
import type { TabBarProps } from './tab-bar-props'
import type { TabBarRuntimeModel } from './model/use-tab-bar-runtime-model'
import type { TabBarCreateMenuController } from './create-menu/tab-bar-create-menu-contract'

export function WorkspaceCreateMenu({
  props,
  onNewPluginFile,
  bot: givenBot,
  botGroup: givenBotGroup,
  excludedTabId,
  runtime,
  createMenu,
  trigger,
  triggerClassName,
  hideTriggerWhenNarrow = false,
  onClosed,
  onOpenChange,
  onEscapeKeyDown
}: {
  props: TabBarProps
  bot?: Bot | null
  botGroup?: BotGroup | null
  excludedTabId?: string | null
  onNewPluginFile?: (newFile: ReturnType<typeof usePluginNewFiles>[number]) => void
  runtime: TabBarRuntimeModel
  createMenu: TabBarCreateMenuController
  trigger?: React.ReactNode
  triggerClassName?: string
  hideTriggerWhenNarrow?: boolean
  onClosed?: () => void
  onOpenChange?: (open: boolean) => void
  onEscapeKeyDown?: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const {
    worktreeId,
    terminalOnly = false,
    showAgentLaunchItems = true,
    onNewTerminalTab,
    onOpenEntry
  } = props
  const workspaceBot = useBotForWorkspace(worktreeId)
  const workspaceBotGroup = useBotGroupForWorkspace(worktreeId)
  const bot = givenBot ?? workspaceBot
  const botGroup = givenBotGroup ?? workspaceBotGroup
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
      onOpenChange={(open) => {
        if (open) {
          createMenu.clearPendingNewTabMenuFocusOnUnmount(null)
        }
        onOpenChange?.(open)
        setNewTabMenuOpen(open)
      }}
      // Why: modal would disable body pointer events, making the Mobile Emulator "Hide" re-enable toast unclickable.
      modal={false}
    >
      <DropdownMenuTrigger asChild>
        {trigger ?? (
          <button
            className={cn(
              'ml-2 my-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground',
              hideTriggerWhenNarrow && '@max-[86px]/tab-strip:hidden',
              triggerClassName
            )}
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            title={t('auto.components.tab.bar.TabBar.b1a132357f', 'New tab')}
            aria-label={t('auto.components.tab.bar.TabBar.b1a132357f', 'New tab')}
            data-contextual-tour-target="tab-create-menu"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        )}
      </DropdownMenuTrigger>
      <NewTabMenuContent
        align="start"
        sideOffset={6}
        className="w-72 max-w-[calc(100vw-1rem)] rounded-[11px] border-border/80 p-1 shadow-[0_16px_36px_rgba(0,0,0,0.24)]"
        onEscapeKeyDown={onEscapeKeyDown}
        onCloseAutoFocus={(event) => {
          // Why: Radix restores focus to the "+" trigger on close, stealing it from the freshly-mounted terminal.
          event.preventDefault()
          runPendingNewTabMenuFocusAfterClose()
          advanceAgentSessionsTourPastNewTab()
          onClosed?.()
        }}
      >
        {!terminalOnly && onOpenEntry ? (
          <>
            <TabBarAgentPickerEntry
              inventory={agentPickerInventory}
              terminalPending={agentMenu.state === 'settled' && agentMenu.terminalPending}
              excludedTabId={excludedTabId}
              hideAgents={botGroup != null}
              botHome={bot && !terminalOnly ? { bot, agentMenu } : null}
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
            onNewPluginFile={onNewPluginFile}
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
