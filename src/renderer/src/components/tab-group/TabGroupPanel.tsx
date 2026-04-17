import { lazy, Suspense } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { Columns2, Ellipsis, Rows2, X } from 'lucide-react'
import { useAppStore } from '../../store'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import TabBar from '../tab-bar/TabBar'
import TerminalPane from '../terminal-pane/TerminalPane'
import BrowserPane from '../browser-pane/BrowserPane'
import { useTabGroupWorkspaceModel } from './useTabGroupWorkspaceModel'
import TabGroupDropOverlay from './TabGroupDropOverlay'
import { getTabPaneBodyDroppableId, type TabDropZone } from './useTabDragSplit'

const EditorPanel = lazy(() => import('../editor/EditorPanel'))

export default function TabGroupPanel({
  groupId,
  worktreeId,
  isWorktreeActive,
  isFocused,
  hasSplitGroups,
  reserveClosedExplorerToggleSpace,
  reserveCollapsedSidebarHeaderSpace,
  isTabDragActive = false,
  activeDropZone = null
}: {
  groupId: string
  worktreeId: string
  isWorktreeActive: boolean
  isFocused: boolean
  hasSplitGroups: boolean
  reserveClosedExplorerToggleSpace: boolean
  reserveCollapsedSidebarHeaderSpace: boolean
  isTabDragActive?: boolean
  activeDropZone?: TabDropZone | null
}): React.JSX.Element {
  const rightSidebarOpen = useAppStore((state) => state.rightSidebarOpen)
  const sidebarOpen = useAppStore((state) => state.sidebarOpen)

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
  const { setNodeRef: setBodyDropRef } = useDroppable({
    id: getTabPaneBodyDroppableId(groupId),
    data: {
      kind: 'pane-body',
      groupId,
      worktreeId
    },
    disabled: !isTabDragActive
  })

  const tabBar = (
    <TabBar
      tabs={terminalTabs}
      activeTabId={activeTab?.contentType === 'terminal' ? activeTab.entityId : null}
      groupId={groupId}
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

  const menuButtonClassName =
    'my-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent'
  const actionChromeClassName = `flex shrink-0 items-center overflow-hidden transition-[width,margin,opacity] duration-150 ${
    isFocused
      ? 'ml-1.5 w-7 pointer-events-auto opacity-100'
      : 'ml-1.5 w-7 pointer-events-none opacity-0'
  }`

  return (
    <div
      className={`group/tab-group flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden${
        hasSplitGroups ? ` border-x border-b ${isFocused ? 'border-accent' : 'border-border'}` : ''
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
          {/* Why: pane-scoped layout actions belong with the active pane instead
              of the global tab-bar `+`, which should keep opening tabs exactly
              as before. The local overflow menu holds split directions and
              close-group without changing the existing tab-creation affordance. */}
          <div
            className={actionChromeClassName}
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            {isFocused ? (
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label="Pane Actions"
                    title="Pane Actions"
                    onClick={(event) => {
                      event.stopPropagation()
                    }}
                    className={menuButtonClassName}
                  >
                    <Ellipsis className="size-4" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" side="bottom" sideOffset={4}>
                  <DropdownMenuItem
                    onSelect={() => {
                      commands.createSplitGroup('right')
                    }}
                  >
                    <Columns2 className="size-4" />
                    Split Right
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => {
                      commands.createSplitGroup('down')
                    }}
                  >
                    <Rows2 className="size-4" />
                    Split Down
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => {
                      commands.createSplitGroup('left')
                    }}
                  >
                    <Columns2 className="size-4" />
                    Split Left
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => {
                      commands.createSplitGroup('up')
                    }}
                  >
                    <Rows2 className="size-4" />
                    Split Up
                  </DropdownMenuItem>
                  {hasSplitGroups ? (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={() => {
                          commands.closeGroup()
                        }}
                      >
                        <X className="size-4" />
                        Close Group
                      </DropdownMenuItem>
                    </>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        </div>
      </div>

      <div ref={setBodyDropRef} className="relative flex-1 min-h-0 overflow-hidden">
        {activeDropZone ? <TabGroupDropOverlay zone={activeDropZone} /> : null}
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
              // input. Hidden worktrees stay mounted offscreen, so `isVisible`
              // must also respect worktree visibility or those detached panes
              // keep their WebGL renderers alive and exhaust Chromium's context
              // budget across worktrees.
              isVisible={
                isWorktreeActive &&
                activeTab?.id === item.id &&
                activeTab.contentType === 'terminal'
              }
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
            style={{
              display: isWorktreeActive && activeBrowserTab?.id === bt.id ? undefined : 'none'
            }}
          >
            <BrowserPane
              browserTab={bt}
              isActive={isWorktreeActive && activeBrowserTab?.id === bt.id}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
