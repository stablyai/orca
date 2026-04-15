import { lazy, Suspense } from 'react'
import { X } from 'lucide-react'
import TabBar from '../tab-bar/TabBar'
import TerminalPane from '../terminal-pane/TerminalPane'
import BrowserPane from '../browser-pane/BrowserPane'
import { useTabGroupWorkspaceModel } from './useTabGroupWorkspaceModel'

const EditorPanel = lazy(() => import('../editor/EditorPanel'))

export default function TabGroupPanel({
  groupId,
  worktreeId,
  isFocused,
  hasSplitGroups
}: {
  groupId: string
  worktreeId: string
  isFocused: boolean
  hasSplitGroups: boolean
}): React.JSX.Element {
  const model = useTabGroupWorkspaceModel({ groupId, worktreeId })
  const {
    activeBrowserTab,
    activeTab,
    browserItems,
    commands,
    editorItems,
    runtimeTerminalTabById,
    tabBarOrder,
    terminalTabs,
    worktreePath
  } = model

  const tabBar = (
    <TabBar
      tabs={terminalTabs}
      activeTabId={activeTab?.contentType === 'terminal' ? activeTab.entityId : null}
      worktreeId={worktreeId}
      expandedPaneByTabId={model.expandedPaneByTabId}
      onActivate={commands.activateTerminal}
      onClose={(terminalId) => {
        const item = model.groupTabs.find(
          (candidate) => candidate.entityId === terminalId && candidate.contentType === 'terminal'
        )
        if (item) {
          commands.closeItem(item.id)
        }
      }}
      onCloseOthers={(terminalId) => {
        const item = model.groupTabs.find(
          (candidate) => candidate.entityId === terminalId && candidate.contentType === 'terminal'
        )
        if (item) {
          commands.closeOthers(item.id)
        }
      }}
      onCloseToRight={(terminalId) => {
        const item = model.groupTabs.find(
          (candidate) => candidate.entityId === terminalId && candidate.contentType === 'terminal'
        )
        if (item) {
          commands.closeToRight(item.id)
        }
      }}
      onReorder={(_, order) => commands.reorderTabBar(order)}
      onNewTerminalTab={commands.newTerminalTab}
      onNewBrowserTab={commands.newBrowserTab}
      onNewFileTab={commands.newFileTab}
      onSetCustomTitle={commands.setTabCustomTitle}
      onSetTabColor={commands.setTabColor}
      onTogglePaneExpand={() => {}}
      editorFiles={editorItems}
      browserTabs={browserItems}
      activeFileId={
        activeTab?.contentType === 'terminal' || activeTab?.contentType === 'browser'
          ? null
          : activeTab?.id
      }
      activeBrowserTabId={activeTab?.contentType === 'browser' ? activeTab.entityId : null}
      activeTabType={
        activeTab?.contentType === 'terminal'
          ? 'terminal'
          : activeTab?.contentType === 'browser'
            ? 'browser'
            : 'editor'
      }
      onActivateFile={commands.activateEditor}
      onCloseFile={commands.closeItem}
      onActivateBrowserTab={commands.activateBrowser}
      onCloseBrowserTab={(browserTabId) => {
        const item = model.groupTabs.find(
          (candidate) => candidate.entityId === browserTabId && candidate.contentType === 'browser'
        )
        if (item) {
          commands.closeItem(item.id)
        }
      }}
      onCloseAllFiles={commands.closeAllEditorTabsInGroup}
      onPinFile={(_fileId, tabId) => {
        if (!tabId) {
          return
        }
        const item = model.groupTabs.find((candidate) => candidate.id === tabId)
        if (!item) {
          return
        }
        commands.pinFile(item.entityId, item.id)
      }}
      tabBarOrder={tabBarOrder}
      onCreateSplitGroup={commands.createSplitGroup}
    />
  )

  return (
    <div
      className={`flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden${
        hasSplitGroups
          ? ` group/tab-group border ${isFocused ? 'border-accent' : 'border-border'}`
          : ''
      }`}
      onPointerDown={commands.focusGroup}
      // Why: keyboard and assistive-tech users can move focus into an unfocused
      // split group without generating a pointer event. Keeping the owning
      // group in sync with DOM focus makes global shortcuts like New Markdown
      // target the panel the user actually navigated into.
      onFocusCapture={commands.focusGroup}
    >
      {/* Why: every split group must keep its own real tab row because the app
          can show multiple groups at once, while the window titlebar only has
          one shared center slot. Rendering true tab chrome here preserves
          per-group titles without making groups fight over one portal target. */}
      <div className="shrink-0 border-b border-border bg-card">
        <div className="flex items-stretch">
          <div className="min-w-0 flex-1">{tabBar}</div>
          {hasSplitGroups && (
            <button
              type="button"
              aria-label="Close Group"
              title="Close Group"
              onClick={(event) => {
                event.stopPropagation()
                commands.closeGroup()
              }}
              className="mx-1 my-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          )}
        </div>
      </div>

      <div className="relative flex-1 min-h-0 overflow-hidden">
        {model.groupTabs
          .filter((item) => item.contentType === 'terminal')
          .map((item) => (
            <TerminalPane
              key={`${item.entityId}-${runtimeTerminalTabById.get(item.entityId)?.generation ?? 0}`}
              tabId={item.entityId}
              worktreeId={worktreeId}
              cwd={worktreePath}
              isActive={
                isFocused && activeTab?.id === item.id && activeTab.contentType === 'terminal'
              }
              // Why: in multi-group splits, the active terminal in each group
              // must remain visible (display:flex) so the user sees its output,
              // but only the focused group's terminal should receive keyboard
              // input. isVisible controls rendering; isActive controls focus.
              isVisible={activeTab?.id === item.id && activeTab.contentType === 'terminal'}
              onPtyExit={(ptyId) => {
                if (commands.consumeSuppressedPtyExit(ptyId)) {
                  return
                }
                commands.closeItem(item.id)
              }}
              onCloseTab={() => commands.closeItem(item.id)}
            />
          ))}

        {activeTab &&
          activeTab.contentType !== 'terminal' &&
          activeTab.contentType !== 'browser' && (
            <div className="absolute inset-0 flex min-h-0 min-w-0">
              {/* Why: split groups render editor/browser content inside a
                  plain relative pane body instead of the legacy flex column in
                  Terminal.tsx. Anchoring the surface to `absolute inset-0`
                  recreates the bounded viewport those panes expect, so plain
                  overflow containers like MarkdownPreview can actually scroll
                  instead of expanding to content height. */}
              <Suspense
                fallback={
                  <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                    Loading editor...
                  </div>
                }
              >
                <EditorPanel activeFileId={activeTab.entityId} activeViewStateId={activeTab.id} />
              </Suspense>
            </div>
          )}

        {browserItems.map((bt) => (
          <div
            key={bt.id}
            className="absolute inset-0 flex min-h-0 min-w-0"
            style={{ display: activeBrowserTab?.id === bt.id ? undefined : 'none' }}
          >
            <BrowserPane browserTab={bt} isActive={activeBrowserTab?.id === bt.id} />
          </div>
        ))}
      </div>
    </div>
  )
}
