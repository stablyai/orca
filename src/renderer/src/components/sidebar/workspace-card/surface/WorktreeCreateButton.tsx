import { restoreWorktreeCreateMenuSurface } from './restore-worktree-create-menu-surface'
import { useState } from 'react'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { workspaceRootGroupId } from '../../../../../../shared/workspace-layout/workspace-layout-minted-ids'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { useTabGroupWorkspaceModel } from '@/components/tab-group/useTabGroupWorkspaceModel'
import { useTabBarRuntimeModel } from '@/components/tab-bar/use-tab-bar-runtime-model'
import { useTabBarCreateMenuController } from '@/components/tab-bar/use-tab-bar-create-menu-controller'
import { usePluginNewFileMenuOptions } from '@/components/tab-bar/use-plugin-new-file-menu-options'
import { WorkspaceCreateMenu } from '@/components/tab-bar/WorkspaceCreateMenu'
import type { TabBarProps } from '@/components/tab-bar/tab-bar-props'

function Trigger(props: React.ComponentProps<typeof Button>): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className="size-5 shrink-0"
      aria-label={translate('auto.components.tab.bar.TabBar.b1a132357f', 'New tab')}
      {...props}
    >
      <Plus className="size-3.5" />
    </Button>
  )
}

export function WorktreeCreateButton({
  worktreeId,
  executionHostId,
  disabled
}: {
  worktreeId: string
  executionHostId: ExecutionHostId
  disabled?: boolean
}): React.JSX.Element {
  const [groupId, setGroupId] = useState<string | null>(null)
  return (
    <span
      className="shrink-0"
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {groupId ? (
        <WorktreeCreateMenu
          worktreeId={worktreeId}
          groupId={groupId}
          onClose={() => {
            setGroupId(null)
            restoreWorktreeCreateMenuSurface(worktreeId, executionHostId)
          }}
        />
      ) : (
        <Trigger
          disabled={disabled}
          onClick={() => {
            if (
              activateAndRevealWorktree(worktreeId, {
                providesInitialSurface: true,
                executionHostId
              }) === false
            ) {
              return
            }
            const state = useAppStore.getState()
            setGroupId(
              state.activeGroupIdByWorktree[worktreeId] ??
                state.groupsByWorktree[worktreeId]?.[0]?.id ??
                workspaceRootGroupId(worktreeId)
            )
          }}
        />
      )}
    </span>
  )
}

function WorktreeCreateMenu({
  worktreeId,
  groupId,
  onClose
}: {
  worktreeId: string
  groupId: string
  onClose: () => void
}): React.JSX.Element {
  const model = useTabGroupWorkspaceModel({ worktreeId, groupId })
  const runtime = useTabBarRuntimeModel({ worktreeId, groupId })
  const { commands } = model
  const activeTabId = model.activeTab?.entityId ?? null
  const props: TabBarProps = {
    worktreeId,
    groupId,
    tabs: model.terminalTabs,
    activeTabId,
    expandedPaneByTabId: model.expandedPaneByTabId,
    onActivate: commands.activateTerminal,
    onClose: commands.closeItem,
    onCloseOthers: commands.closeOthers,
    onCloseToRight: commands.closeToRight,
    onCloseToLeft: commands.closeToLeft,
    onNewTerminalTab: commands.newTerminalTab,
    onNewTerminalWithShell: commands.newTerminalWithShell,
    onNewBrowserTab: commands.newBrowserTab,
    onNewSimulatorTab: commands.newSimulatorTab,
    onNewFileTab: commands.newFileTab,
    onOpenEntry: commands.openEntry,
    onSetCustomTitle: commands.setTabCustomTitle,
    onSetTabColor: commands.setTabColor,
    onTogglePaneExpand: commands.toggleTerminalPaneExpand
  }
  const controller = useTabBarCreateMenuController({
    ...runtime,
    worktreeId,
    resolvedGroupId: runtime.resolvedGroupId,
    terminalOnly: false,
    initialOpen: true,
    onNewTerminalTab: props.onNewTerminalTab,
    onNewTerminalWithShell: props.onNewTerminalWithShell,
    onNewBrowserTab: props.onNewBrowserTab,
    onNewSimulatorTab: props.onNewSimulatorTab,
    onNewFileTab: props.onNewFileTab
  })
  const plugins = usePluginNewFileMenuOptions(
    controller.createMenuOptions,
    controller.handleSelectCreateMenuOption,
    runtime.resolvedGroupId
  )
  return (
    <WorkspaceCreateMenu
      props={props}
      runtime={runtime}
      createMenu={{
        ...controller,
        createMenuOptions: plugins.menuOptions,
        handleSelectCreateMenuOption: plugins.onSelectMenuOption
      }}
      trigger={<Trigger />}
      onClosed={onClose}
    />
  )
}
