import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { Columns2, Rows2, X } from 'lucide-react'
import { useAppStore } from '../../store'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import TabBar from '../tab-bar/TabBar'
import TerminalPane from '../terminal-pane/TerminalPane'
import BrowserPane from '../browser-pane/BrowserPane'
import { useTabGroupWorkspaceModel } from './useTabGroupWorkspaceModel'

const EditorPanel = lazy(() => import('../editor/EditorPanel'))
const isMac = navigator.userAgent.includes('Mac')

export default function TabGroupPanel({
  groupId,
  worktreeId,
  isFocused,
  hasSplitGroups,
  showSplitButton,
  reserveClosedExplorerToggleSpace,
  reserveCollapsedSidebarHeaderSpace
}: {
  groupId: string
  worktreeId: string
  isFocused: boolean
  hasSplitGroups: boolean
  showSplitButton: boolean
  reserveClosedExplorerToggleSpace: boolean
  reserveCollapsedSidebarHeaderSpace: boolean
}): React.JSX.Element {
  const rightSidebarOpen = useAppStore((state) => state.rightSidebarOpen)
  const sidebarOpen = useAppStore((state) => state.sidebarOpen)

  // Why: track Option/Alt key state so the split button icon can preview the
  // alternate direction (down) before the user clicks, matching the modifier-
  // toggle convention used in VS Code and macOS toolbars.
  const [altHeld, setAltHeld] = useState(false)
  useEffect(() => {
    if (!showSplitButton) {
      return
    }
    const clearAltHeld = (): void => {
      setAltHeld(false)
    }
    const down = (e: KeyboardEvent): void => {
      if (e.key === 'Alt') {
        setAltHeld(true)
      }
    }
    const up = (e: KeyboardEvent): void => {
      if (e.key === 'Alt') {
        clearAltHeld()
      }
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    // Why: if the user Alt+Tabs away, this window may never receive the keyup
    // event, so clear the preview state on blur to avoid a stuck split-down icon.
    window.addEventListener('blur', clearAltHeld)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', clearAltHeld)
    }
  }, [showSplitButton])

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

  const handleSplit = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation()
      const direction = event.altKey ? 'down' : 'right'
      commands.createSplitGroup(direction)
    },
    [commands]
  )

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
          ? ` group/tab-group border-x border-b ${isFocused ? 'border-accent' : 'border-border'}`
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
      <div className="h-[42px] shrink-0 border-b border-border bg-card">
        <div
          className={`flex h-full items-stretch pr-1.5${
            reserveClosedExplorerToggleSpace && !rightSidebarOpen ? ' pr-10' : ''
          }`}
          style={{
            paddingLeft:
              reserveCollapsedSidebarHeaderSpace && !sidebarOpen
                ? 'var(--collapsed-sidebar-header-width)'
                : undefined
          }}
        >
          {/* Why: when the right sidebar is closed, App.tsx renders a floating
              explorer toggle in the top-right corner of the workspace. Only the
              top-right tab group can sit underneath that button, so reserve
              space in just that one header instead of pushing every group in. */}
          {/* Why: collapsing the left worktree sidebar should let the terminal
              reclaim the full left edge, but the top-left tab row should still
              stop where the remaining titlebar controls end. Use the measured
              width of that controls cluster instead of the old full sidebar
              width so tabs cap at the agent badge, not at the old divider. */}
          <div className="min-w-0 flex-1 h-full">{tabBar}</div>
          {showSplitButton && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={altHeld ? 'Split Editor Down' : 'Split Editor Right'}
                  onClick={handleSplit}
                  className="my-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                  style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
                >
                  {altHeld ? <Rows2 size={16} /> : <Columns2 size={16} />}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={4}>
                <div className="flex flex-col">
                  <span>Split Right</span>
                  {/* Why: split-button modifier hints appear in a shared header UI,
                      so the label must match the current platform's modifier
                      vocabulary instead of always showing Mac glyphs. */}
                  <span className="text-muted-foreground">[{isMac ? '⌥' : 'Alt'}] Split Down</span>
                </div>
              </TooltipContent>
            </Tooltip>
          )}
          {hasSplitGroups && (
            <button
              type="button"
              aria-label="Close Group"
              title="Close Group"
              onClick={(event) => {
                event.stopPropagation()
                commands.closeGroup()
              }}
              className="my-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground"
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
