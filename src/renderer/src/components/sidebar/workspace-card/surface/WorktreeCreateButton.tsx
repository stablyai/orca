import { afterPendingWorkspaceTabs } from '@/runtime/layout-owner-pending-tabs'
import { restoreWorktreeCreateMenuSurface } from './restore-worktree-create-menu-surface'
import { useState, useRef } from 'react'
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
          executionHostId={executionHostId}
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
  executionHostId,
  worktreeId,
  groupId,
  onClose
}: {
  worktreeId: string
  groupId: string
  onClose: () => void
  executionHostId: ExecutionHostId
}): React.JSX.Element {
  const pending = useRef(new Set<Promise<unknown>>())
  function track<Result>(action: () => Result): Result {
    const result = action()
    const completion = Promise.resolve(result)
    pending.current.add(completion)
    void completion.then(
      () => pending.current.delete(completion),
      () => pending.current.delete(completion)
    )
    return result
  }
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
    onNewTerminalTab: () =>
      track(() =>
        useAppStore
          .getState()
          .openNewTerminalTabInActiveWorkspace(groupId, worktreeId, executionHostId)
      ),
    onNewTerminalWithShell: (shell) => track(() => commands.newTerminalWithShell(shell)),
    onNewBrowserTab: () => track(commands.newBrowserTab),
    onNewSimulatorTab: commands.newSimulatorTab
      ? () => track(() => commands.newSimulatorTab?.())
      : undefined,
    onNewFileTab: () => track(commands.newFileTab),
    onOpenEntry: (entry) => track(() => commands.openEntry(entry)),
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
        handleSelectCreateMenuOption: (option) => track(() => plugins.onSelectMenuOption(option)),
        launchAgentRow: (...args: Parameters<typeof controller.launchAgentRow>) =>
          track(() => controller.launchAgentRow(...args)),
        launchAgentFromNewTabEntry: (option) =>
          track(() => controller.launchAgentFromNewTabEntry(option))
      }}
      trigger={<Trigger />}
      onClosed={() => {
        void Promise.allSettled(pending.current).then(() =>
          afterPendingWorkspaceTabs(worktreeId, onClose)
        )
      }}
    />
  )
}
