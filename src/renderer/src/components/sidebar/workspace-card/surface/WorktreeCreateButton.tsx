import { focusWorktreeCreateTriggerAfterDismissal } from './worktree-create-menu-dismissal-focus'
import { ProjectAgentLaunchButton } from '@/components/tab-bar/ProjectAgentLaunchButton'
import { afterPendingWorkspaceTabs } from '@/runtime/workspace-layout/intents/layout-owner-pending-tabs'
import { restoreWorktreeCreateMenuSurface } from './restore-worktree-create-menu-surface'
import { useState, useRef, useLayoutEffect, useCallback } from 'react'
import type { usePluginNewFiles } from '@/store/plugins/file-creation/plugin-new-files'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { workspaceRootGroupId } from '../../../../../../shared/workspace-layout/persistence/workspace-layout-minted-ids'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from '@/lib/workspace/activation/worktree-activation'
import { useTabGroupWorkspaceModel } from '@/components/tab-group/useTabGroupWorkspaceModel'
import { useTabBarRuntimeModel } from '@/components/tab-bar/use-tab-bar-runtime-model'
import { useTabBarCreateMenuController } from '@/components/tab-bar/use-tab-bar-create-menu-controller'
import { usePluginNewFileMenuOptions } from '@/components/tab-bar/use-plugin-new-file-menu-options'
import { WorkspaceCreateMenu } from '@/components/tab-bar/WorkspaceCreateMenu'
import type { TabBarProps } from '@/components/tab-bar/tab-bar-props'

function Trigger(props: React.ComponentProps<typeof Button>): React.JSX.Element {
  const t = useTranslate()
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className="size-5 shrink-0"
      aria-label={t('auto.components.tab.bar.TabBar.b1a132357f', 'New tab')}
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
  const root = useRef<HTMLSpanElement>(null)
  const [groupId, setGroupId] = useState<string | null>(null)
  const focusAfterClose = useRef(false)
  useLayoutEffect(() => {
    if (groupId === null && focusAfterClose.current) {
      focusAfterClose.current = false
      return focusWorktreeCreateTriggerAfterDismissal(root.current, worktreeId, executionHostId)
    }
    return undefined
  }, [groupId, worktreeId, executionHostId])
  return (
    <span
      ref={root}
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
          onClose={(restoreFocus) => {
            focusAfterClose.current = restoreFocus
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
      <ProjectAgentLaunchButton
        worktreeId={worktreeId}
        executionHostId={executionHostId}
        disabled={disabled}
      />
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
  onClose: (restoreFocus: boolean) => void
  executionHostId: ExecutionHostId
}): React.JSX.Element {
  const mounted = useRef(false)
  const closed = useRef(false)
  const menuOpen = useRef(true)
  const closeGeneration = useRef(0)
  const keyboardDismissal = useRef(false)
  const pending = useRef(new Set<Promise<unknown>>())
  function track<Result>(action: () => Result): Result {
    keyboardDismissal.current = false
    const result = action()
    const completion = Promise.resolve(result)
    pending.current.add(completion)
    void completion.then(
      () => pending.current.delete(completion),
      () => pending.current.delete(completion)
    )
    return result
  }
  const onNewPluginFile = (newFile: ReturnType<typeof usePluginNewFiles>[number]) =>
    track(() =>
      useAppStore
        .getState()
        .openNewPluginFileInActiveWorkspace(newFile, groupId, worktreeId, executionHostId)
    )
  const model = useTabGroupWorkspaceModel({ worktreeId, groupId, executionHostId })
  const runtime = useTabBarRuntimeModel({ worktreeId, groupId, executionHostId })
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
    onNewFileTab: () =>
      track(() =>
        useAppStore
          .getState()
          .openNewMarkdownInActiveWorkspace(groupId, worktreeId, executionHostId)
      ),
    onOpenEntry: (entry) => track(() => commands.openEntry(entry)),
    onSetCustomTitle: commands.setTabCustomTitle,
    onSetTabColor: commands.setTabColor,
    onTogglePaneExpand: commands.toggleTerminalPaneExpand
  }
  const controller = useTabBarCreateMenuController({
    ...runtime,
    worktreeId,
    executionHostId,
    resolvedGroupId: runtime.resolvedGroupId,
    terminalOnly: false,
    initialOpen: true,
    onNewTerminalTab: props.onNewTerminalTab,
    onNewTerminalWithShell: props.onNewTerminalWithShell,
    onNewBrowserTab: props.onNewBrowserTab,
    onNewSimulatorTab: props.onNewSimulatorTab,
    onNewFileTab: props.onNewFileTab
  })
  useLayoutEffect(() => {
    menuOpen.current = controller.newTabMenuOpen
  }, [controller.newTabMenuOpen])
  const clearFocus = controller.clearPendingNewTabMenuFocusOnUnmount
  const triggerRef = useCallback(
    (node: HTMLButtonElement | null) => {
      if (!node) {
        return
      }
      mounted.current = true
      return () => {
        mounted.current = false
        closeGeneration.current++
        if (closed.current) {
          return
        }
        clearFocus(null)
        void Promise.allSettled(pending.current).then(() =>
          afterPendingWorkspaceTabs(worktreeId, () => {
            if (!mounted.current) {
              restoreWorktreeCreateMenuSurface(worktreeId, executionHostId)
            }
          })
        )
      }
    },
    [worktreeId, executionHostId, clearFocus]
  )
  const plugins = usePluginNewFileMenuOptions(
    controller.createMenuOptions,
    controller.handleSelectCreateMenuOption,
    runtime.resolvedGroupId,
    onNewPluginFile
  )
  return (
    <WorkspaceCreateMenu
      props={props}
      onNewPluginFile={onNewPluginFile}
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
      trigger={<Trigger ref={triggerRef} />}
      onOpenChange={(open) => {
        menuOpen.current = open
        if (open) {
          closeGeneration.current++
          keyboardDismissal.current = false
        }
      }}
      onEscapeKeyDown={() => {
        keyboardDismissal.current = true
      }}
      onClosed={() => {
        if (menuOpen.current) {
          return
        }
        const generation = ++closeGeneration.current
        const restoreFocus = keyboardDismissal.current
        void Promise.allSettled(pending.current).then(() =>
          afterPendingWorkspaceTabs(worktreeId, () => {
            if (generation === closeGeneration.current) {
              closed.current = true
              onClose(restoreFocus)
            }
          })
        )
      }}
    />
  )
}
