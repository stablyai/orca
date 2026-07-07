import { Suspense, useMemo } from 'react'
import { lazyWithRetry as lazy } from '@/lib/lazy-with-retry'
import { useDroppable } from '@dnd-kit/core'
import { Ellipsis, X } from 'lucide-react'
import { useAppStore } from '../../store'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import TabBar from '../tab-bar/TabBar'

import { TabBarQuickCommandsButton } from '../tab-bar/TabBarQuickCommandsButton'
import { useTabGroupWorkspaceModel } from './useTabGroupWorkspaceModel'
import { closeTerminalTab } from '../terminal/terminal-tab-actions'
import { resolveGroupTabFromVisibleId } from './tab-group-visible-id'
import { getTabPaneBodyDroppableId, type HoveredTabInsertion } from './useTabDragSplit'
import { tabGroupBodyAnchorName } from './tab-group-body-anchor'
import { translate } from '@/i18n/i18n'

const EditorPanel = lazy(() => import('../editor/EditorPanel'))

export default function TabGroupPanel({
  groupId,
  worktreeId,
  isFocused,
  hasSplitGroups,
  touchesRightEdge,
  touchesLeftEdge,
  reserveClosedExplorerToggleSpace,
  reserveCollapsedSidebarHeaderSpace,
  isTabDragActive = false,
  hoveredTabInsertion = null
}: {
  groupId: string
  worktreeId: string
  isFocused: boolean
  hasSplitGroups: boolean
  touchesRightEdge: boolean
  touchesLeftEdge: boolean
  reserveClosedExplorerToggleSpace: boolean
  reserveCollapsedSidebarHeaderSpace: boolean
  isTabDragActive?: boolean
  hoveredTabInsertion?: HoveredTabInsertion | null
}): React.JSX.Element {
  const rightSidebarOpen = useAppStore((state) => state.rightSidebarOpen)
  const sidebarOpen = useAppStore((state) => state.sidebarOpen)

  const model = useTabGroupWorkspaceModel({ groupId, worktreeId })
  const { activeTab, browserItems, commands, editorItems, tabBarOrder, terminalTabs } = model
  const { setNodeRef: setBodyDropRef } = useDroppable({
    id: getTabPaneBodyDroppableId(groupId),
    data: {
      kind: 'pane-body',
      groupId,
      worktreeId
    },
    disabled: !isTabDragActive
  })
  // Why: browser and terminal panes for this worktree are rendered once at the worktree
  // level (BrowserPaneOverlayLayer) and positioned over the owning group's
  // body via CSS anchor positioning. Tagging this body with a per-group
  // `anchor-name` lets the overlay reference it via `position-anchor`;
  // moving a tab between groups only swaps which anchor-name the overlay
  // targets. Browsers avoid `<webview>` reloads; terminals avoid remounting
  // xterm and losing alt-screen TUI state.
  const bodyAnchorName = tabGroupBodyAnchorName(groupId)
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
        const item = resolveGroupTabFromVisibleId(model.groupTabs, terminalId)
        if (item?.contentType === 'terminal') {
          commands.closeItem(item.id)
          return
        }
        // Why: agent quick-launch can briefly desync unified/runtime tab ids
        // before the host snapshot lands; still route close through the shared
        // terminal close helper instead of no-op'ing.
        closeTerminalTab(terminalId)
      }}
      onCloseOthers={(visibleId) => {
        // Why: TabBar emits this with the entityId for terminals/browsers and
        // the unifiedTabId for editors (see TabBar's per-type wiring). Match
        // both so the menu works on every tab kind, not just terminals.
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
      onNewTerminalTab={commands.newTerminalTab}
      onNewTerminalWithShell={commands.newTerminalWithShell}
      onNewBrowserTab={commands.newBrowserTab}
      onNewSimulatorTab={commands.newSimulatorTab}
      onNewTasksTab={commands.newTasksTab}
      onOpenEntry={commands.openEntry}
      onNewFileTab={commands.newFileTab}
      onSetCustomTitle={commands.setTabCustomTitle}
      onSetTabColor={commands.setTabColor}
      onTogglePaneExpand={commands.toggleTerminalPaneExpand}
      editorFiles={editorItems}
      browserTabs={browserItems}
      activeFileId={
        activeTab?.contentType === 'terminal' ||
        activeTab?.contentType === 'browser' ||
        activeTab?.contentType === 'simulator' ||
        activeTab?.contentType === 'tasks'
          ? null
          : activeTab?.id
      }
      activeBrowserTabId={activeTab?.contentType === 'browser' ? activeTab.entityId : null}
      activeSimulatorTabId={activeTab?.contentType === 'simulator' ? activeTab.id : null}
      activeTasksTabId={activeTab?.contentType === 'tasks' ? activeTab.id : null}
      activeTabType={
        activeTab?.contentType === 'terminal'
          ? 'terminal'
          : activeTab?.contentType === 'browser'
            ? 'browser'
            : activeTab?.contentType === 'simulator'
              ? 'simulator'
              : activeTab?.contentType === 'tasks'
                ? 'tasks'
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
      onMakePreviewFilePermanent={(_fileId, tabId) => {
        if (!tabId) {
          return
        }
        const item = model.groupTabs.find((candidate) => candidate.id === tabId)
        if (!item) {
          return
        }
        commands.makePreviewFilePermanent(item.entityId, item.id)
      }}
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
      hoveredTabInsertion={hoveredTabInsertion}
    />
  )

  const menuButtonClassName =
    'my-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent'
  // Why: focused-only — quick commands and Close split pane stay with the
  // active pane so unfocused strips stay compact.
  const focusedActionChromeClassName = `flex shrink-0 items-center gap-0.5 overflow-hidden transition-[opacity] duration-150 ${
    isFocused ? 'ml-1.5 pointer-events-auto opacity-100' : 'pointer-events-none opacity-0 w-0'
  }`
  return (
    <div
      // Why: vertical borders are always `border-border` so the focus
      // highlight doesn't introduce a near-white strip next to the split
      // resize handle (--accent is ~#f5f5f5 in light mode, which reads as a
      // visible gap between the dragger and the tab row). Only the bottom
      // border changes color on focus, which is enough to cue the focused
      // group without painting a bright line along the vertical edges.
      // Why: unfocused split groups dim very subtly so the focused group
      // reads as "selected" without making the unfocused content look
      // washed out or hard to read. Only applied when `hasSplitGroups`
      // because a lone group has nothing to contrast against.
      className={`group/tab-group relative flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden${
        hasSplitGroups
          ? // Why: drop the outer borders on the edge-touching groups. The
            // TabGroupSplitLayout wrapper already paints a full-height
            // `border-l` at the sidebar seam, and the right sidebar paints
            // its own `borderLeft` at the right seam — painting our own
            // border-l/border-r in those spots stacks a second 1px line
            // next to it, reading as a ~2px bar below the drag strip
            // (where the sibling border continues alone above).
            ` ${touchesLeftEdge ? '' : 'border-l'} ${touchesRightEdge ? '' : 'border-r'} border-border border-b ${isFocused ? 'border-b-accent' : 'opacity-95'}`
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
      {/* Why: the macOS window uses hiddenInset titleBarStyle, so the only
          way to drag-move the window is via -webkit-app-region: drag. Without
          this, the empty space after tabs in the center column is dead — the
          user can only drag from the tiny left-sidebar header strip. */}
      <div
        className="h-[32px] shrink-0 border-b border-border bg-card"
        data-tab-group-strip-id={groupId}
        data-terminal-focus-release-surface="true"
        data-worktree-id={worktreeId}
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
          <div
            className="ml-1.5 flex shrink-0 items-center gap-0.5"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <div className={focusedActionChromeClassName}>
              {isFocused ? (
                <TabBarQuickCommandsButton worktreeId={worktreeId} groupId={groupId} />
              ) : null}
              {isFocused && hasSplitGroups ? (
                <Tooltip>
                  <DropdownMenu modal={false}>
                    <TooltipTrigger asChild>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          aria-label={translate(
                            'auto.components.tab.group.TabGroupPanel.9acaf92093',
                            'Pane Actions'
                          )}
                          onClick={(event) => {
                            event.stopPropagation()
                          }}
                          className={menuButtonClassName}
                        >
                          <Ellipsis className="size-4" />
                        </button>
                      </DropdownMenuTrigger>
                    </TooltipTrigger>
                    <DropdownMenuContent align="end" side="bottom" sideOffset={4}>
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={() => {
                          commands.closeGroup()
                        }}
                      >
                        <X className="size-4" />
                        {translate(
                          'auto.components.tab.group.TabGroupPanel.closePaneColumn',
                          'Close split pane'
                        )}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <TooltipContent side="bottom" sideOffset={6}>
                    {translate(
                      'auto.components.tab.group.TabGroupPanel.9acaf92093',
                      'Pane Actions'
                    )}
                  </TooltipContent>
                </Tooltip>
              ) : null}
            </div>
          </div>
          {/* Why: Electron's native drag hit-test ignores z-index — a no-drag
              element only overrides drag when it's a DOM descendant, not a
              sibling in another branch. The floating right-sidebar toggle and
              the fixed-position window-controls overlay for custom desktop
              chrome both sit in separate DOM trees, so we need an explicit
              no-drag child here to punch holes in the drag surface beneath
              them. The sidebar toggle is 40px (w-10); window controls add
              --window-controls-width (138px when active, 0px otherwise) on top. */}
          {reserveClosedExplorerToggleSpace && !rightSidebarOpen ? (
            <div
              className="shrink-0"
              style={
                {
                  width: 'calc(40px + var(--window-controls-width, 0px))',
                  WebkitAppRegion: 'no-drag'
                } as React.CSSProperties
              }
            />
          ) : null}
        </div>
      </div>

      <div
        ref={setBodyDropRef}
        data-tab-group-body-id={groupId}
        data-worktree-id={worktreeId}
        className="relative flex-1 min-h-0 overflow-hidden"
        style={bodyAnchorStyle}
      >
        {/* Why: this empty anchor lets the agent-sessions tour read as a
            terminal-area tip instead of attaching to toolbar chrome. */}
        {isFocused ? (
          <div
            className="pointer-events-none absolute inset-x-0 top-1/4 h-px"
            data-contextual-tour-target="workspace-agent-terminal-tip"
          />
        ) : null}
        {activeTab &&
          activeTab.contentType !== 'terminal' &&
          activeTab.contentType !== 'browser' &&
          activeTab.contentType !== 'simulator' &&
          activeTab.contentType !== 'tasks' && (
            <div className="absolute inset-0 flex min-h-0 min-w-0">
              {/* Why: split groups render editor content inside a plain relative pane body
                  instead of the legacy flex column in Terminal.tsx. */}
              <Suspense
                fallback={
                  <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                    {translate(
                      'auto.components.tab.group.TabGroupPanel.814fb04c43',
                      'Loading editor...'
                    )}
                  </div>
                }
              >
                <EditorPanel activeFileId={activeTab.entityId} activeViewStateId={activeTab.id} />
              </Suspense>
            </div>
          )}

        {/* Why: terminal/browser/simulator panes are rendered at the worktree level by
            overlay layers and absolutely positioned over this body element
            via the slot registered above. Rendering them per-group caused
            split moves to remount xterm, reparent Electron `<webview>`, or
            reload the simulator stream. */}
      </div>
    </div>
  )
}
