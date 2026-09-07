import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import type { WorkspacePane, WindowPaneLayout } from '../../../../shared/window-pane-types'
import { toVisibleTabType } from '../../../../shared/tab-types'
import { resolveWorkspaceView } from '@/store/slices/window-pane-selection'
import { useTabGroupWorkspaceModel } from '../tab-group/useTabGroupWorkspaceModel'
import TabBar from '../tab-bar/TabBar'
import { Button } from '../ui/button'
import { projectPaneContext } from './project-pane-context'

export function WorkspacePaneStrip({
  pane,
  layout
}: {
  pane: WorkspacePane
  layout: WindowPaneLayout
}) {
  const state = useAppStore(
    useShallow((s) => ({
      unifiedTabsByWorktree: s.unifiedTabsByWorktree,
      tabsByWorktree: s.tabsByWorktree,
      openFiles: s.openFiles,
      browserTabsByWorktree: s.browserTabsByWorktree,
      expandedPaneByTabId: s.expandedPaneByTabId,
      repos: s.repos,
      projects: s.projects,
      projectHostSetups: s.projectHostSetups,
      worktreesByRepo: s.worktreesByRepo,
      folderWorkspaces: s.folderWorkspaces,
      projectGroups: s.projectGroups,
      runtimeEnvironments: s.runtimeEnvironments,
      sshTargetLabels: s.sshTargetLabels,
      removedSshTargetLabels: s.removedSshTargetLabels,
      runtimeStatusByEnvironmentId: s.runtimeStatusByEnvironmentId,
      sshConnectionStates: s.sshConnectionStates
    }))
  )
  const tabs = useMemo(
    () =>
      pane.viewIds.flatMap((id, index) => {
        const view = layout.views[id]
        const tab = resolveWorkspaceView(
          useAppStore.getState(),
          view,
          state.unifiedTabsByWorktree[view.worktreeId]
        )
        const repeated = pane.viewIds
          .slice(0, index)
          .some((other) => layout.views[other].tabId === view.tabId)
        const presentationId = repeated
          ? id
          : tab?.contentType === 'terminal' || tab?.contentType === 'browser'
            ? tab.entityId
            : tab?.id
        return tab && presentationId ? [{ ...tab, viewId: id, presentationId }] : []
      }),
    [layout.views, pane.viewIds, state.unifiedTabsByWorktree]
  )
  const selected = tabs.find((tab) => tab.viewId === pane.selectedViewId)
  const contexts = pane.viewIds.map((id) =>
    projectPaneContext(useAppStore.getState(), layout.views[id])
  )
  const mixed = new Set(contexts.map((context) => context.projectKey)).size > 1
  const presentationContext = Object.fromEntries(
    tabs.map((tab) => {
      const context = contexts[pane.viewIds.indexOf(tab.viewId)]
      return [
        tab.presentationId,
        {
          projectName: mixed ? context.projectName : '',
          accentColor: context.accentColor,
          label: context.label,
          viewId: tab.viewId,
          paneId: pane.id
        }
      ]
    })
  )
  const worktreeId = selected?.worktreeId ?? pane.workspace?.worktreeId ?? ''
  const ownerGroupId = useAppStore((s) => s.activeGroupIdByWorktree[worktreeId])
  const model = useTabGroupWorkspaceModel({
    worktreeId,
    groupId: selected?.groupId ?? ownerGroupId ?? ''
  })
  const { commands } = model
  const projections = useMemo(
    () => ({
      terminals: tabs
        .filter((tab) => tab.contentType === 'terminal')
        .map((tab) => ({
          ...state.tabsByWorktree[tab.worktreeId]?.find((item) => item.id === tab.entityId),
          id: tab.presentationId,
          unifiedTabId: tab.id,
          worktreeId: tab.worktreeId,
          ptyId:
            state.tabsByWorktree[tab.worktreeId]?.find((item) => item.id === tab.entityId)?.ptyId ??
            null,
          title: tab.customLabel ?? tab.label,
          sortOrder: tab.sortOrder,
          createdAt: tab.createdAt,
          customTitle: tab.customLabel,
          color: tab.color
        })),
      editors: tabs
        .filter((tab) => toVisibleTabType(tab.contentType) === 'editor')
        .flatMap((tab) => {
          const file = state.openFiles.find(
            (file) => file.id === tab.entityId && file.worktreeId === tab.worktreeId
          )
          return file ? [{ ...file, tabId: tab.presentationId }] : []
        }),
      browsers: tabs
        .filter((tab) => tab.contentType === 'browser')
        .flatMap((tab) => {
          const browser = state.browserTabsByWorktree[tab.worktreeId]?.find(
            (item) => item.id === tab.entityId
          )
          return browser ? [{ ...browser, id: tab.presentationId, tabId: tab.id }] : []
        }),
      agents: tabs.filter(
        (tab): tab is typeof tab & { contentType: 'agent-session' } =>
          tab.contentType === 'agent-session'
      ),
      order: tabs.map((tab) => tab.presentationId)
    }),
    [tabs, state]
  )
  const findView = (visibleId: string) =>
    tabs.find((tab) => tab.presentationId === visibleId)?.viewId
  const activate = (visibleId: string) => {
    const viewId = findView(visibleId)
    if (viewId) {
      useAppStore.getState().focusWindowPane(pane.id, viewId)
    }
  }
  const close = (visibleId: string) => {
    const viewId = findView(visibleId)
    if (viewId) {
      useAppStore.getState().closeWorkspaceView(pane.id, viewId)
    }
  }
  const closeRange = (visibleId: string, direction: 'others' | 'left' | 'right') => {
    const index = pane.viewIds.indexOf(findView(visibleId) ?? '')
    for (const [i, id] of pane.viewIds.entries()) {
      if (direction === 'others' ? i !== index : direction === 'left' ? i < index : i > index) {
        useAppStore.getState().closeWorkspaceView(pane.id, id)
      }
    }
  }
  const focus = () => useAppStore.getState().focusWindowPane(pane.id)
  const unresolved = pane.viewIds.filter(
    (id) => !tabs.some((tab) => tab.id === layout.views[id].tabId)
  )
  return (
    <div className="flex h-full min-w-0">
      {unresolved.map((id) => (
        <Button
          key={id}
          variant="ghost"
          size="xs"
          aria-label={contexts[pane.viewIds.indexOf(id)].label}
          title={contexts[pane.viewIds.indexOf(id)].label}
          onClick={() => useAppStore.getState().focusWindowPane(pane.id, id)}
        >
          {mixed && (
            <span className="max-w-32 truncate text-muted-foreground">
              {contexts[pane.viewIds.indexOf(id)].projectName}
            </span>
          )}
          {layout.views[id].label ?? 'Unavailable session'}
        </Button>
      ))}
      {(!pane.selectedViewId || selected || tabs.length > 0) && (
        <TabBar
          creationDisabled={!!pane.selectedViewId && !selected}
          worktreeId={worktreeId}
          groupId={selected?.groupId}
          presentationTabs={tabs}
          presentationContext={presentationContext}
          presentationPaneId={pane.id}
          tabs={projections.terminals}
          editorFiles={projections.editors}
          browserTabs={projections.browsers}
          agentSessionTabs={projections.agents}
          tabBarOrder={projections.order}
          activeTabId={selected?.presentationId ?? null}
          activeFileId={selected?.presentationId}
          activeBrowserTabId={selected?.contentType === 'browser' ? selected.presentationId : null}
          activeSimulatorTabId={selected?.presentationId}
          activeTabType={selected ? toVisibleTabType(selected.contentType) : 'terminal'}
          expandedPaneByTabId={state.expandedPaneByTabId}
          onActivate={activate}
          onActivateFile={activate}
          onActivateBrowserTab={activate}
          onActivateAgentSession={activate}
          onClose={close}
          onCloseFile={close}
          onCloseBrowserTab={close}
          onCloseOthers={(id) => closeRange(id, 'others')}
          onCloseToLeft={(id) => closeRange(id, 'left')}
          onCloseToRight={(id) => closeRange(id, 'right')}
          onCloseAllFiles={() => projections.editors.forEach((file) => close(file.tabId))}
          onNewTerminalTab={() => {
            focus()
            commands.newTerminalTab()
          }}
          onNewBrowserTab={() => {
            focus()
            commands.newBrowserTab()
          }}
          onNewFileTab={() => {
            focus()
            void commands.newFileTab()
          }}
          onNewTerminalWithShell={(shell) => {
            focus()
            commands.newTerminalWithShell(shell)
          }}
          onOpenEntry={async (args) => {
            focus()
            await commands.openEntry(args)
          }}
          onSetCustomTitle={(id, title) =>
            commands.setTabCustomTitle(
              tabs.find((tab) => tab.presentationId === id)?.entityId ?? id,
              title
            )
          }
          onSetTabColor={(id, color) =>
            commands.setTabColor(
              tabs.find((tab) => tab.presentationId === id)?.entityId ?? id,
              color
            )
          }
          onTogglePaneExpand={() => useAppStore.getState().expandWindowPane(pane.id)}
          onMakePreviewFilePermanent={(id, tabId) =>
            commands.makePreviewFilePermanent(
              id,
              tabs.find((tab) => tab.presentationId === tabId)?.id ?? tabId
            )
          }
          onPinFile={(id, tabId) =>
            commands.pinFile(id, tabs.find((tab) => tab.presentationId === tabId)?.id ?? tabId)
          }
        />
      )}
    </div>
  )
}
