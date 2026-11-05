import React from 'react'
import { Plus } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { ProjectedAgentMenuItems } from './QuickLaunchButton'
import { TabBarAgentPickerEntry } from './TabBarAgentPickerEntry'
import { TabBarStaticCreateMenu } from './tab-bar-static-create-menu'
import { advanceAgentSessionsTourPastNewTab } from '@/components/contextual-tours/agent-sessions-tour-new-tab'
import type { TabBarProps } from './tab-bar-props'
import type { TabBarRuntimeModel } from './use-tab-bar-runtime-model'
import type { TabBarCreateMenuController } from './tab-bar-create-menu-contract'

export function WorkspaceCreateMenu({
  props,
  runtime,
  createMenu,
  trigger,
  onClosed
}: {
  props: TabBarProps
  runtime: TabBarRuntimeModel
  createMenu: TabBarCreateMenuController
  trigger?: React.ReactNode
  onClosed?: () => void
}): React.JSX.Element {
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
  return (
    <DropdownMenu
      open={newTabMenuOpen}
      onOpenChange={setNewTabMenuOpen}
      // Why: modal would disable body pointer events, making the Mobile Emulator "Hide" re-enable toast unclickable.
      modal={false}
    >
      <DropdownMenuTrigger asChild>
        {trigger ?? (
          <button
            className="ml-2 my-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            title={translate('auto.components.tab.bar.TabBar.b1a132357f', 'New tab')}
            aria-label={translate('auto.components.tab.bar.TabBar.b1a132357f', 'New tab')}
            data-contextual-tour-target="tab-create-menu"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        )}
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
          onClosed?.()
        }}
      >
        {!terminalOnly && onOpenEntry ? (
          <>
            <TabBarAgentPickerEntry
              inventory={agentPickerInventory}
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
  )
}
