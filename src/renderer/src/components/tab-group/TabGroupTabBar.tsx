import TabBar from '../tab-bar/TabBar'
import { closeTerminalTab } from '../terminal/terminal-tab-actions'
import { resolveGroupTabFromVisibleId } from './tab-group-visible-id'
import { useTabGroupWorkspaceModel } from './useTabGroupWorkspaceModel'
import type { HoveredTabInsertion } from './useTabDragSplit'
import type { ClientHostedBrowserRow } from '../../../../shared/client-hosted-browser-rows'

type Model = ReturnType<typeof useTabGroupWorkspaceModel>

export function TabGroupTabBar({
  model,
  groupId,
  worktreeId,
  clientHostedBrowserRows,
  hoveredTabInsertion = null
}: {
  model: Model
  groupId: string
  worktreeId: string
  clientHostedBrowserRows?: readonly ClientHostedBrowserRow[]
  hoveredTabInsertion?: HoveredTabInsertion | null
}): React.JSX.Element {
  const {
    activeTab,
    agentSessionItems,
    browserItems,
    commands,
    editorItems,
    tabBarOrder,
    terminalTabs
  } = model
  return (
    <TabBar
      tabs={terminalTabs}
      activeTabId={
        activeTab?.contentType === 'terminal'
          ? activeTab.entityId
          : activeTab?.contentType === 'agent-session'
            ? activeTab.id
            : null
      }
      groupId={groupId}
      worktreeId={worktreeId}
      expandedPaneByTabId={model.expandedPaneByTabId}
      onActivate={commands.activateTerminal}
      onClose={(terminalId) => {
        const item = resolveGroupTabFromVisibleId(model.groupTabs, terminalId)
        if (item?.contentType === 'terminal' || item?.contentType === 'agent-session') {
          commands.closeItem(item.id)
          return
        }
        closeTerminalTab(terminalId)
      }}
      onCloseOthers={(visibleId) => {
        const item = resolveGroupTabFromVisibleId(model.groupTabs, visibleId)
        if (item) {
          commands.closeOthers(item.id)
        }
      }}
      onCloseToRight={(visibleId) => {
        const item = resolveGroupTabFromVisibleId(model.groupTabs, visibleId)
        if (item) {
          commands.closeToRight(item.id)
        }
      }}
      onCloseToLeft={(visibleId) => {
        const item = resolveGroupTabFromVisibleId(model.groupTabs, visibleId)
        if (item) {
          commands.closeToLeft(item.id)
        }
      }}
      onNewTerminalTab={commands.newTerminalTab}
      onNewTerminalWithShell={commands.newTerminalWithShell}
      onNewBrowserTab={commands.newBrowserTab}
      onNewSimulatorTab={commands.newSimulatorTab}
      onOpenEntry={commands.openEntry}
      onNewFileTab={commands.newFileTab}
      onSetCustomTitle={commands.setTabCustomTitle}
      onSetTabColor={commands.setTabColor}
      onTogglePaneExpand={commands.toggleTerminalPaneExpand}
      editorFiles={editorItems}
      browserTabs={browserItems}
      clientHostedBrowserRows={clientHostedBrowserRows}
      groupActiveTabId={activeTab?.id ?? null}
      agentSessionTabs={agentSessionItems}
      activeFileId={
        activeTab?.contentType === 'terminal' ||
        activeTab?.contentType === 'agent-session' ||
        activeTab?.contentType === 'browser' ||
        activeTab?.contentType === 'simulator' ||
        activeTab?.contentType === 'room'
          ? null
          : activeTab?.id
      }
      activeBrowserTabId={activeTab?.contentType === 'browser' ? activeTab.entityId : null}
      activeSimulatorTabId={activeTab?.contentType === 'simulator' ? activeTab.id : null}
      activeTabType={
        activeTab?.contentType === 'terminal'
          ? 'terminal'
          : activeTab?.contentType === 'agent-session'
            ? 'agent-session'
            : activeTab?.contentType === 'browser'
              ? 'browser'
              : activeTab?.contentType === 'simulator'
                ? 'simulator'
                : 'editor'
      }
      onActivateFile={commands.activateEditor}
      onCloseFile={commands.closeItem}
      onActivateBrowserTab={commands.activateBrowser}
      onActivateAgentSession={commands.activateAgentSession}
      onCloseBrowserTab={(browserTabId) => {
        const item = model.groupTabs.find(
          (candidate) => candidate.entityId === browserTabId && candidate.contentType === 'browser'
        )
        if (item) {
          commands.closeItem(item.id)
        }
      }}
      onDuplicateBrowserTab={commands.duplicateBrowserTab}
      onCloseAllFiles={commands.closeAllEditorTabsInGroup}
      onMakePreviewFilePermanent={(_fileId, tabId) => {
        if (!tabId) {
          return
        }
        const item = model.groupTabs.find((candidate) => candidate.id === tabId)
        if (item) {
          commands.makePreviewFilePermanent(item.entityId, item.id)
        }
      }}
      onPinFile={(_fileId, tabId) => {
        if (!tabId) {
          return
        }
        const item = model.groupTabs.find((candidate) => candidate.id === tabId)
        if (item) {
          commands.pinFile(item.entityId, item.id)
        }
      }}
      tabBarOrder={tabBarOrder}
      hoveredTabInsertion={hoveredTabInsertion}
    />
  )
}

export function WorkspaceTitlebarTabs({
  groupId,
  worktreeId
}: {
  groupId: string
  worktreeId: string
}): React.JSX.Element {
  const model = useTabGroupWorkspaceModel({ groupId, worktreeId })
  return <TabGroupTabBar model={model} groupId={groupId} worktreeId={worktreeId} />
}
