import { lazy, Suspense, useMemo } from 'react'
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
import { browserSlotAnchorName } from '../browser-pane/browser-pane-slots'
import { useTabGroupWorkspaceModel } from './useTabGroupWorkspaceModel'
import TabGroupDropOverlay from './TabGroupDropOverlay'
import {
  getTabPaneBodyDroppableId,
  type HoveredTabInsertion,
  type TabDropZone
} from './useTabDragSplit'

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
  activeDropZone = null,
  hoveredTabInsertion = null
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
  hoveredTabInsertion?: HoveredTabInsertion | null
}): React.JSX.Element {
  const rightSidebarOpen = useAppStore((state) => state.rightSidebarOpen)
  const sidebarOpen = useAppStore((state) => state.sidebarOpen)

  const model = useTabGroupWorkspaceModel({ groupId, worktreeId })
  const {
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
  // Why: browser panes for this worktree are rendered once at the worktree
  // level (BrowserPaneOverlayLayer) and positioned over the owning group's
  // body via CSS anchor positioning. Tagging this body with a per-group
  // `anchor-name` lets the overlay reference it via `position-anchor`;
  // moving a tab between groups only swaps which anchor-name the overlay
  // targets, never reparenting the `<webview>` (which would reload it).
  const bodyAnchorName = browserSlotAnchorName(groupId)
  // Why: memoize the style object so the literal isn't recreated on every
  // render. A fresh object every render would make the body `<div>` appear
  // to have a new `style` prop on every parent re-render, which defeats any
  // downstream memoization keyed on referential equality.
  const bodyAnchorStyle = useMemo(
    () => ({ anchorName: bodyAnchorName }) as React.CSSProperties,
    [bodyAnchorName]
  )

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
      onDuplicateBrowserTab={commands.duplicateBrowserTab}
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
      hoveredTabInsertion={hoveredTabInsertion}
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
      {/* Why: the macOS window uses hiddenInset titleBarStyle, so the only
          way to drag-move the window is via -webkit-app-region: drag. Without
          this, the empty space after tabs in the center column is dead — the
          user can only drag from the tiny left-sidebar header strip. */}
      <div
        className="h-[42px] shrink-0 border-b border-border bg-card"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div className="flex h-full items-stretch pr-1.5">
          {/* Why: Electron's native drag hit-test only respects no-drag on DOM
              descendants, not z-index siblings. When the left sidebar is
              collapsed, its header floats absolutely (z-10) over this tab row
              from a separate DOM branch. An explicit no-drag spacer here
              punches a hole in the drag surface so the floating sidebar toggle
              and other titlebar controls remain clickable. */}
          {reserveCollapsedSidebarHeaderSpace && !sidebarOpen ? (
            <div
              className="shrink-0"
              style={
                {
                  width: 'var(--collapsed-sidebar-header-width)',
                  WebkitAppRegion: 'no-drag'
                } as React.CSSProperties
              }
            />
          ) : null}
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
          {/* Why: Electron's native drag hit-test ignores z-index — a no-drag
              element only overrides drag when it's a DOM descendant, not a
              sibling in another branch. The floating right-sidebar toggle in
              App.tsx sits in a separate DOM tree, so we need an explicit
              no-drag child here to punch a hole in the drag surface beneath it
              and let clicks through to the toggle. */}
          {reserveClosedExplorerToggleSpace && !rightSidebarOpen ? (
            <div
              className="shrink-0 w-10"
              style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            />
          ) : null}
        </div>
      </div>

      <div
        ref={setBodyDropRef}
        className="relative flex-1 min-h-0 overflow-hidden"
        style={bodyAnchorStyle}
      >
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

        {/* Why: browser panes are rendered at the worktree level by
            BrowserPaneOverlayLayer and absolutely positioned over this body
            element via the slot registered above. Rendering them per-group
            here caused moving a browser tab between groups to unmount and
            remount the pane, reparenting the Electron `<webview>` — which
            destroys its guest contents and reloads the page. */}
      </div>
    </div>
  )
}
