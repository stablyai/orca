import TabBar from '@/components/tab-bar/TabBar'
import { TabGroupSplitNodeTree } from '@/components/tab-group/TabGroupSplitNodeTree'
import { WorkspaceTabDragLayer } from '@/components/tab-group/WorkspaceTabDragLayer'
import { WorkspacePaneOverlayLayers } from '@/components/WorkspacePaneOverlayLayers'
import { isTerminalImeInputContextRefreshing } from '@/components/terminal-pane/terminal-ime-input-context-refresh'
import { buildDuplicatedBrowserTabOptions } from '@/lib/duplicate-browser-tab-options'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { FloatingTerminalEmptyState } from './FloatingTerminalEmptyState'
import { renderFloatingTerminalOrchestrationCard } from './FloatingTerminalOrchestrationCard'
import { FloatingTerminalOrchestrationDialog } from './FloatingTerminalOrchestrationDialog'
import { FloatingTerminalResizeHandles } from './FloatingTerminalResizeHandles'
import { renderFloatingTerminalSaveDialog } from './FloatingTerminalSaveDialog'
import { FloatingTerminalWindowControls } from './FloatingTerminalWindowControls'
import type { useFloatingTerminalPanelController } from './use-floating-terminal-panel-controller'

const NO_ACTIVITY_TERMINAL_PORTALS: [] = []

export function renderFloatingTerminalPanelSurface({
  open,
  onOpenChange,
  bounds,
  maximized,
  stagedBoundsRef,
  setPanelNode,
  commitUserBounds,
  reportFloatingFocusFromTarget,
  handleShortcutSurfaceKeyDown,
  handleDragStart,
  handleDragMove,
  handleDragEnd,
  handleTitlebarDoubleClick,
  surface,
  model,
  terminalItems,
  activeGroup,
  activeTerminalId,
  activeEditorUnifiedId,
  activeBrowserId,
  activeTab,
  activeTabType,
  expandedPaneByTabId,
  closeFloatingItemConfirmed,
  closeOthers,
  closeToRight,
  closeToLeft,
  createFloatingTerminalTab,
  createFloatingBrowserTab,
  createFloatingMarkdownTab,
  openFloatingMarkdownTab,
  setTabCustomTitle,
  setTabColor,
  setTabPaneExpanded,
  createBrowserTab,
  closeAllFiles,
  makePreviewFilePermanent,
  pinFile,
  toggleMaximized,
  hasVisibleFloatingTabs,
  managedBrowserCreationEnabled,
  cwd,
  panelViewportSettled,
  focusPanelForShortcuts,
  newTerminalShortcut,
  newBrowserShortcut,
  newMarkdownShortcut,
  openMarkdownShortcut,
  closeShortcut,
  showOrchestrationSetup,
  dismissOrchestrationSetup,
  setOrchestrationDialogOpen,
  previewUserBounds,
  orchestrationDialogOpen,
  refreshOrchestrationSetupVisibility,
  saveDialogFileId,
  saveDialogFile,
  handleFloatingSaveDialogCancel,
  handleFloatingSaveDialogDiscard,
  handleFloatingSaveDialogSave
}: ReturnType<typeof useFloatingTerminalPanelController>): React.JSX.Element {
  return (
    // Why: sit above the z-40 notification cards so the floating workspace is
    // never buried behind them, but stay under the z-50 modal layer so its own
    // orchestration/save dialogs (and every app modal) still open above it.
    // Drop shadow on the outer shell, border on an inner shell — mixing both on
    // one rounded node made corners look stubby. Floating tabs skip their top
    // border so the titlebar curve stays clean.
    <div
      ref={setPanelNode}
      data-floating-terminal-panel
      aria-hidden={!open}
      tabIndex={-1}
      className={`fixed z-[45] flex min-h-[280px] min-w-[420px] rounded-lg bg-transparent text-card-foreground shadow-[0_4px_12px_rgba(0,0,0,0.16),0_24px_64px_rgba(0,0,0,0.32)] outline-none dark:shadow-[0_8px_20px_rgba(0,0,0,0.35),0_28px_72px_rgba(0,0,0,0.58)] ${open ? 'opacity-100' : 'invisible pointer-events-none opacity-0'}`}
      style={{
        visibility: open ? 'visible' : 'hidden',
        left: bounds.left,
        top: bounds.top,
        width: bounds.width,
        height: bounds.height
      }}
      onMouseUp={(event) => {
        if (maximized || !stagedBoundsRef.current) {
          return
        }
        const rect = event.currentTarget.getBoundingClientRect()
        commitUserBounds({
          ...stagedBoundsRef.current,
          width: rect.width,
          height: rect.height
        })
      }}
      onFocusCapture={(event) => reportFloatingFocusFromTarget(event.target)}
      onBlurCapture={(event) => {
        // Why: keep terminal-first shortcut ownership latched during the
        // synchronous macOS IME refresh blur; refocus or its skip callback settles it.
        if (!isTerminalImeInputContextRefreshing(event.target)) {
          reportFloatingFocusFromTarget(event.relatedTarget)
        }
      }}
      onKeyDownCapture={handleShortcutSurfaceKeyDown}
    >
      {/* Why one drag layer around titlebar AND body: the titlebar strip's sortables and the
          body tree's split/pane-body drop targets must live in the same dnd-kit scope, so a
          floating tab drag can reorder in the strip or split against the tree — exactly one
          DndContext owns floating tab drag. */}
      <WorkspaceTabDragLayer worktreeId={FLOATING_TERMINAL_WORKTREE_ID} enabled={open}>
        {({ isTabDragActive, hoveredTabInsertion, setDragRootNode }) => (
          <div
            ref={setDragRootNode}
            className="relative flex h-full w-full min-h-0 flex-col overflow-hidden rounded-lg border border-black/14 bg-card dark:border-white/14"
          >
            <div
              className="flex h-9 shrink-0 cursor-grab items-center border-b border-border bg-[var(--bg-titlebar,var(--card))] active:cursor-grabbing"
              data-floating-terminal-shortcut-surface
              onPointerDown={handleDragStart}
              onPointerMove={handleDragMove}
              onPointerUp={handleDragEnd}
              onPointerCancel={handleDragEnd}
              onDoubleClick={handleTitlebarDoubleClick}
            >
              <div className="flex h-full min-w-0 flex-1">
                <TabBar
                  tabs={terminalItems}
                  activeTabId={
                    activeTab?.contentType === 'agent-session' ? activeTab.id : activeTerminalId
                  }
                  groupId={activeGroup?.id}
                  worktreeId={FLOATING_TERMINAL_WORKTREE_ID}
                  expandedPaneByTabId={expandedPaneByTabId}
                  onActivate={model.commands.activateTerminal}
                  onClose={closeFloatingItemConfirmed}
                  onCloseOthers={closeOthers}
                  onCloseToRight={closeToRight}
                  onCloseToLeft={closeToLeft}
                  onNewTerminalTab={() => createFloatingTerminalTab()}
                  onNewTerminalWithShell={createFloatingTerminalTab}
                  onNewBrowserTab={createFloatingBrowserTab}
                  onNewFileTab={createFloatingMarkdownTab}
                  onOpenFileTab={openFloatingMarkdownTab}
                  newTabMenuOrder="markdown-first"
                  onSetCustomTitle={setTabCustomTitle}
                  onSetTabColor={setTabColor}
                  onTogglePaneExpand={(tabId) =>
                    setTabPaneExpanded(tabId, expandedPaneByTabId[tabId] !== true)
                  }
                  editorFiles={model.editorItems}
                  browserTabs={model.browserItems}
                  agentSessionTabs={model.agentSessionItems}
                  groupActiveTabId={activeTab?.id ?? null}
                  activeFileId={activeEditorUnifiedId}
                  activeBrowserTabId={activeBrowserId}
                  activeSimulatorTabId={
                    activeTab?.contentType === 'simulator' ? activeTab.id : null
                  }
                  activeTabType={activeTabType}
                  onActivateFile={model.commands.activateEditor}
                  onCloseFile={closeFloatingItemConfirmed}
                  onActivateBrowserTab={model.commands.activateBrowser}
                  onActivateAgentSession={model.commands.activateAgentSession}
                  onCloseBrowserTab={closeFloatingItemConfirmed}
                  onDuplicateBrowserTab={(browserTabId) => {
                    const source = model.browserItems.find((tab) => tab.id === browserTabId)
                    if (!source) {
                      return
                    }
                    createBrowserTab(FLOATING_TERMINAL_WORKTREE_ID, source.url, {
                      ...buildDuplicatedBrowserTabOptions(source),
                      targetGroupId: activeGroup?.id,
                      browserRuntimeEnvironmentId: null
                    })
                  }}
                  onCloseAllFiles={closeAllFiles}
                  onMakePreviewFilePermanent={makePreviewFilePermanent}
                  onPinFile={pinFile}
                  tabBarOrder={model.tabBarOrder}
                  hoveredTabInsertion={hoveredTabInsertion}
                  tabStripChrome="floating-panel"
                />
              </div>
              <FloatingTerminalWindowControls
                maximized={maximized}
                onToggleMaximized={toggleMaximized}
                onMinimize={() => onOpenChange(false)}
              />
            </div>

            <div
              className="relative min-h-0 flex-1 overflow-hidden bg-background"
              data-contextual-tour-target={
                hasVisibleFloatingTabs ? 'floating-workspace-surface' : undefined
              }
            >
              {/* Why also gated on resolvable items: stale unified tabs whose entities are gone
                  must show the empty state (with its CTAs), not a blank group body. */}
              {surface.kind === 'workspace' && hasVisibleFloatingTabs ? (
                // Why the flex frame: the tree's nodes size themselves as flex items (flex-1), so
                // the host must own their rect with a flex container — same contract as
                // WorktreeSplitSurface. In a block parent every pane collapses to 0px.
                <div className="absolute inset-0 flex" data-floating-workspace-surface-frame>
                  <TabGroupSplitNodeTree
                    layout={surface.layout}
                    worktreeId={FLOATING_TERMINAL_WORKTREE_ID}
                    focusedGroupId={surface.focusedGroupId}
                    isWorktreeActive={open}
                    isTabDragActive={isTabDragActive}
                    hoveredTabInsertion={hoveredTabInsertion}
                    // Why external: the titlebar strip above is the panel's one tab row.
                    tabStrip="external"
                    // Why: floating workspace markdown is scratch/local context,
                    // not a repo review surface that should expose agent notes.
                    markdownAnnotationsEnabled={false}
                    rootTouchesBottomEdge={true}
                  />
                  {/* Why also gated on a settled viewport: a restored-maximized panel derives its
                      rect from the live viewport, so mounting terminals before the window finishes
                      maximizing fits them to a grid it is about to leave, and the correcting fit
                      reflows the buffer under a live TUI. An empty worktreePath mounts no
                      terminal panes; browser/editor/chat panes are not viewport-fitted. */}
                  <WorkspacePaneOverlayLayers
                    worktreeId={FLOATING_TERMINAL_WORKTREE_ID}
                    worktreePath={cwd && panelViewportSettled ? cwd : ''}
                    isVisible={open}
                    shouldMeasureHiddenWorktree={false}
                    shouldColdParkTerminalPanes={false}
                    isForceParked={false}
                    activityTerminalPortals={NO_ACTIVITY_TERMINAL_PORTALS}
                    backgroundMountTabIds={null}
                    activationDeferredMountTabIds={null}
                    mountRetainedBrowserOverlay={true}
                    mountEmulatorOverlay={true}
                    // Why: the active workspace's listener owns the chord while the panel overlays it.
                    ownsNativeChatToggleShortcut={false}
                  />
                </div>
              ) : (
                <FloatingTerminalEmptyState
                  onNewTerminal={() => createFloatingTerminalTab()}
                  onNewMarkdown={createFloatingMarkdownTab}
                  onOpenMarkdown={openFloatingMarkdownTab}
                  onNewBrowser={createFloatingBrowserTab}
                  showNewBrowser={managedBrowserCreationEnabled}
                  onClose={() => onOpenChange(false)}
                  onFocusPanel={focusPanelForShortcuts}
                  newTerminalShortcut={newTerminalShortcut}
                  newBrowserShortcut={newBrowserShortcut}
                  newMarkdownShortcut={newMarkdownShortcut}
                  openMarkdownShortcut={openMarkdownShortcut}
                  closeShortcut={closeShortcut}
                />
              )}
            </div>
          </div>
        )}
      </WorkspaceTabDragLayer>
      {renderFloatingTerminalOrchestrationCard({
        visible: showOrchestrationSetup && activeTabType === 'terminal',
        onDismiss: dismissOrchestrationSetup,
        onEnable: () => setOrchestrationDialogOpen(true)
      })}
      {!maximized && (
        <FloatingTerminalResizeHandles
          bounds={bounds}
          onPreviewBounds={previewUserBounds}
          onCommitBounds={commitUserBounds}
        />
      )}
      <FloatingTerminalOrchestrationDialog
        open={orchestrationDialogOpen}
        onOpenChange={setOrchestrationDialogOpen}
        onSetupStateChange={() => void refreshOrchestrationSetupVisibility()}
      />
      {renderFloatingTerminalSaveDialog({
        saveDialogFileId,
        saveDialogFile,
        handleFloatingSaveDialogCancel,
        handleFloatingSaveDialogDiscard,
        handleFloatingSaveDialogSave
      })}
    </div>
  )
}
