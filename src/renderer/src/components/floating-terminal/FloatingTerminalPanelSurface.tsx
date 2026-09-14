import { Suspense } from 'react'
import { lazyWithRetry as lazy } from '@/lib/lazy-with-retry'
import EmulatorPane from '@/components/emulator-pane/EmulatorPane'
import TabBar from '@/components/tab-bar/TabBar'
import TerminalPane from '@/components/terminal-pane/TerminalPane'
import { shouldDeferParkedPtyExitTabClose } from '@/components/terminal-pane/terminal-parked-tab-watchers'
import { closeTerminalTab } from '@/components/terminal/terminal-tab-actions'
import { isTerminalImeInputContextRefreshing } from '@/components/terminal-pane/terminal-ime-input-context-refresh'
import { buildDuplicatedBrowserTabOptions } from '@/lib/duplicate-browser-tab-options'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { isProvenProcessExit } from '../../../../shared/terminal-exit-cause'
import { FloatingBrowserSlot } from './FloatingBrowserSlot'
import { FloatingTerminalEmptyState } from './FloatingTerminalEmptyState'
import { renderFloatingTerminalOrchestrationCard } from './FloatingTerminalOrchestrationCard'
import { FloatingTerminalOrchestrationDialog } from './FloatingTerminalOrchestrationDialog'
import { FloatingTerminalResizeHandles } from './FloatingTerminalResizeHandles'
import { renderFloatingTerminalSaveDialog } from './FloatingTerminalSaveDialog'
import { FloatingTerminalWindowControls } from './FloatingTerminalWindowControls'
import { FloatingWorkspaceTabDragContext } from './FloatingWorkspaceTabDragContext'
import type { useFloatingTerminalPanelController } from './use-floating-terminal-panel-controller'

const EditorPanel = lazy(() => import('@/components/editor/EditorPanel'))

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
  terminalItems,
  activeTerminalId,
  expandedPaneByTabId,
  activateFloatingItem,
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
  editorItems,
  browserItems,
  activeEditorUnifiedId,
  activeBrowserId,
  activeTab,
  activeTabType,
  browserTabs,
  createBrowserTab,
  activeGroup,
  closeAllFiles,
  makePreviewFilePermanent,
  pinFile,
  tabBarOrder,
  toggleMaximized,
  hasVisibleFloatingTabs,
  managedBrowserCreationEnabled,
  cwd,
  panelViewportSettled,
  tabs,
  parkedTerminalTabIds,
  terminalPaneRegistry,
  activeBrowserTab,
  simulatorItems,
  activeEditorFile,
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
      <div className="relative flex h-full w-full min-h-0 flex-col overflow-hidden rounded-lg border border-black/14 bg-card dark:border-white/14">
        <div
          className="flex h-9 shrink-0 cursor-grab items-center border-b border-border bg-[var(--bg-titlebar,var(--card))] active:cursor-grabbing"
          data-floating-terminal-shortcut-surface
          onPointerDown={handleDragStart}
          onPointerMove={handleDragMove}
          onPointerUp={handleDragEnd}
          onPointerCancel={handleDragEnd}
          onDoubleClick={handleTitlebarDoubleClick}
        >
          <FloatingWorkspaceTabDragContext enabled={open}>
            <TabBar
              tabs={terminalItems}
              activeTabId={activeTerminalId}
              worktreeId={FLOATING_TERMINAL_WORKTREE_ID}
              expandedPaneByTabId={expandedPaneByTabId}
              onActivate={activateFloatingItem}
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
              editorFiles={editorItems}
              browserTabs={browserItems}
              activeFileId={activeEditorUnifiedId}
              activeBrowserTabId={activeBrowserId}
              activeSimulatorTabId={activeTab?.contentType === 'simulator' ? activeTab.id : null}
              activeTabType={activeTabType}
              onActivateFile={activateFloatingItem}
              onCloseFile={closeFloatingItemConfirmed}
              onActivateBrowserTab={activateFloatingItem}
              onCloseBrowserTab={closeFloatingItemConfirmed}
              onDuplicateBrowserTab={(browserTabId) => {
                const source = browserTabs.find((tab) => tab.id === browserTabId)
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
              tabBarOrder={tabBarOrder}
              tabStripChrome="floating-panel"
            />
          </FloatingWorkspaceTabDragContext>
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
          {/* Why also gated on a settled viewport: a restored-maximized panel derives its
              rect from the live viewport, so mounting terminals before the window finishes
              maximizing fits them to a grid it is about to leave, and the correcting fit
              reflows the buffer under a live TUI. */}
          {cwd && panelViewportSettled
            ? tabs
                .filter((tab) => !parkedTerminalTabIds.has(tab.id))
                .map((tab) => {
                  const isActive = tab.id === activeTerminalId
                  return (
                    <div
                      key={`${tab.id}-${tab.generation ?? 0}`}
                      className={isActive ? 'absolute inset-0' : 'absolute inset-0 hidden'}
                      aria-hidden={!isActive}
                    >
                      <TerminalPane
                        ref={terminalPaneRegistry.getRefCallback(tab.id)}
                        tabId={tab.id}
                        worktreeId={FLOATING_TERMINAL_WORKTREE_ID}
                        cwd={cwd}
                        isActive={isActive}
                        // Why: the closed panel is only CSS-hidden, so gate
                        // visibility on `open` too. This routes the floating
                        // terminal through the standard hidden-terminal
                        // suspend/resume path: no live WebGL context (or glyph
                        // atlas to corrupt) while hidden, and the resume on
                        // reopen rebuilds the renderer from scratch.
                        isVisible={isActive && open}
                        onPtyExit={(ptyId, exitCode) => {
                          if (exitCode !== undefined && !isProvenProcessExit(exitCode)) {
                            useAppStore.getState().markUnverifiedPtyLoss(tab.id)
                            return
                          }
                          if (shouldDeferParkedPtyExitTabClose(tab.id, ptyId)) {
                            return
                          }
                          closeTerminalTab(tab.id, {
                            reason: 'pty-exit',
                            lifecyclePtyId: ptyId
                          })
                        }}
                        onCloseTab={() => closeFloatingItemConfirmed(tab.id)}
                      />
                    </div>
                  )
                })
            : null}
          {browserTabs.map((tab) => {
            const isActive = tab.id === activeBrowserTab?.id
            return (
              <div
                key={tab.id}
                className={isActive ? 'absolute inset-0 flex' : 'absolute inset-0 hidden'}
                aria-hidden={!isActive}
              >
                <FloatingBrowserSlot browserTab={tab} isActive={open && isActive} />
              </div>
            )
          })}
          {simulatorItems.map((tab) => {
            const isActive = tab.id === activeTab?.id
            return (
              <div
                key={tab.id}
                className={isActive ? 'absolute inset-0 flex' : 'absolute inset-0 hidden'}
                aria-hidden={!isActive}
              >
                <EmulatorPane tab={tab} worktreeId={tab.worktreeId} isActive={open && isActive} />
              </div>
            )
          })}
          {activeEditorFile ? (
            <div className="absolute inset-0 flex min-h-0 min-w-0">
              <Suspense
                fallback={
                  <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                    {translate(
                      'auto.components.floating.terminal.FloatingTerminalPanel.d6b563ae24',
                      'Loading editor...'
                    )}
                  </div>
                }
              >
                {/* Why: floating workspace markdown is scratch/local context,
                    not a repo review surface that should expose agent notes. */}
                <EditorPanel
                  activeFileId={activeEditorFile.id}
                  activeViewStateId={activeEditorUnifiedId}
                  isVisible={open}
                  markdownAnnotationsEnabled={false}
                />
              </Suspense>
            </div>
          ) : null}
          {!hasVisibleFloatingTabs ? (
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
          ) : null}
        </div>
      </div>
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
