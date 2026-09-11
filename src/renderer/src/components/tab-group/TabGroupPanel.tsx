import { Suspense, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { lazyWithRetry as lazy } from '@/lib/lazy-with-retry'
import { useDroppable } from '@dnd-kit/core'
import { SYNC_FIT_PANES_EVENT } from '@/constants/terminal'
import { useAppStore } from '../../store'
import TabBar from '../tab-bar/TabBar'

import { TabBarQuickCommandsButton } from '../tab-bar/TabBarQuickCommandsButton'
import { useTabGroupWorkspaceModel } from './useTabGroupWorkspaceModel'
import { closeTerminalTab } from '../terminal/terminal-tab-actions'
import { resolveGroupTabFromVisibleId } from './tab-group-visible-id'
import { getTabPaneBodyDroppableId, type HoveredTabInsertion } from './useTabDragSplit'
import { tabGroupBodyAnchorName } from './tab-group-body-anchor'
import { resolveSingleTabStripVisibility } from './single-tab-strip-visibility'
import { useTabStripRevealHover } from './tab-strip-reveal-hover'
import { TabGroupPaneActionsMenu } from './TabGroupPaneActionsMenu'
import { translate } from '@/i18n/i18n'
import type { TabGroup } from '../../../../shared/tab-types'
import type { ClientHostedBrowserRow } from '../../../../shared/client-hosted-browser-rows'
import { useClientHostedBrowserRows } from '@/lib/pane-manager/client-hosted-browser-row-state'
import { resolveClientHostedBrowserRowStripGroupId } from '../tab-bar/client-hosted-browser-row-strip-placement'

const EditorPanel = lazy(() => import('../editor/EditorPanel'))
const EMPTY_GROUPS: readonly TabGroup[] = []
const EMPTY_CLIENT_HOSTED_ROWS: readonly ClientHostedBrowserRow[] = []

export default function TabGroupPanel({
  groupId,
  worktreeId,
  isVisible,
  isFocused,
  hasSplitGroups,
  touchesRightEdge,
  touchesLeftEdge,
  touchesBottomEdge = false,
  suppressLeftBorder = false,
  suppressRightBorder = false,
  suppressBottomBorder = false,
  reserveClosedExplorerToggleSpace,
  reserveCollapsedSidebarHeaderSpace,
  isTabDragActive = false,
  hoveredTabInsertion = null
}: {
  groupId: string
  worktreeId: string
  isVisible: boolean
  isFocused: boolean
  hasSplitGroups: boolean
  touchesRightEdge: boolean
  touchesLeftEdge: boolean
  touchesBottomEdge?: boolean
  suppressLeftBorder?: boolean
  suppressRightBorder?: boolean
  suppressBottomBorder?: boolean
  reserveClosedExplorerToggleSpace: boolean
  reserveCollapsedSidebarHeaderSpace: boolean
  isTabDragActive?: boolean
  hoveredTabInsertion?: HoveredTabInsertion | null
}): React.JSX.Element {
  const rightSidebarOpen = useAppStore((state) => state.rightSidebarOpen)
  const sidebarOpen = useAppStore((state) => state.sidebarOpen)
  const model = useTabGroupWorkspaceModel({ groupId, worktreeId })
  const {
    activeTab,
    agentSessionItems,
    browserItems,
    commands,
    editorItems,
    tabBarOrder,
    terminalTabs
  } = model
  // Why: one strip owns the worktree's client-hosted rows, or every split repeats them.
  const ownsClientHostedRows = useAppStore(
    (state) =>
      resolveClientHostedBrowserRowStripGroupId(
        state.groupsByWorktree[worktreeId] ?? EMPTY_GROUPS
      ) === groupId
  )
  const worktreeClientHostedRows = useClientHostedBrowserRows(worktreeId)
  const clientHostedRows = ownsClientHostedRows
    ? worktreeClientHostedRows
    : EMPTY_CLIENT_HOSTED_ROWS
  const autoHideSingleTabStrip = useAppStore(
    (state) => state.settings?.autoHideSingleTabStrip === true
  )
  const [stripHovered, setStripHovered] = useState(false)
  const { autoHidden: stripAutoHidden, revealed: stripRevealed } = resolveSingleTabStripVisibility({
    autoHideEnabled: autoHideSingleTabStrip,
    groupTabCount: model.groupTabs.length,
    clientHostedRowCount: clientHostedRows.length,
    stripHovered,
    tabDragActive: isTabDragActive
  })
  // Why: the watcher stops with the collapsed strip, so a reveal that ends by gaining a tab never
  // sees the pointer leave and would come back already revealed once the group drops to one tab again.
  if (!stripAutoHidden && stripHovered) {
    setStripHovered(false)
  }
  const panelRef = useRef<HTMLDivElement | null>(null)
  useTabStripRevealHover({
    enabled: stripAutoHidden && isVisible,
    panelRef,
    onHoverChange: setStripHovered
  })
  // Why: this transition moves the pane body by 32px and xterm only reflows on this event; skipping
  // the mount run matters because every worktree's groups stay mounted and each would refit them all.
  const didSyncStripHeightRef = useRef(false)
  useLayoutEffect(() => {
    if (!didSyncStripHeightRef.current) {
      didSyncStripHeightRef.current = true
      return
    }
    window.dispatchEvent(new CustomEvent(SYNC_FIT_PANES_EVENT))
  }, [stripAutoHidden])
  const { setNodeRef: setBodyDropRef } = useDroppable({
    id: getTabPaneBodyDroppableId(groupId),
    data: {
      kind: 'pane-body',
      groupId,
      worktreeId
    },
    disabled: !isTabDragActive
  })
  // Why: per-group anchor-name lets the worktree-level overlay position panes via CSS anchor positioning, so moving a tab between groups re-targets the anchor instead of remounting xterm (loses alt-screen TUI state) or reloading `<webview>`.
  const bodyAnchorName = tabGroupBodyAnchorName(groupId)
  // Why: memoize so a fresh style object each render doesn't break downstream memoization keyed on referential equality.
  const bodyAnchorStyle = useMemo(
    () => ({ anchorName: bodyAnchorName }) as React.CSSProperties,
    [bodyAnchorName]
  )

  const tabBar = (
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
        // Why: agent quick-launch can briefly desync unified/runtime tab ids before the host snapshot lands, so still route close through the shared helper.
        closeTerminalTab(terminalId)
      }}
      onCloseOthers={(visibleId) => {
        // Why: TabBar emits entityId for terminals/browsers but unifiedTabId for editors; match both so the menu works on every tab kind.
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
      clientHostedBrowserRows={clientHostedRows}
      groupActiveTabId={activeTab?.id ?? null}
      agentSessionTabs={agentSessionItems}
      activeFileId={
        activeTab?.contentType === 'terminal' ||
        activeTab?.contentType === 'agent-session' ||
        activeTab?.contentType === 'browser' ||
        activeTab?.contentType === 'simulator'
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

  // Why: focused-only so quick commands and Close split pane stay with the active pane and unfocused strips stay compact.
  const focusedActionChromeClassName = `flex shrink-0 items-center gap-0.5 overflow-hidden transition-[opacity] duration-150 ${
    isFocused ? 'ml-1.5 pointer-events-auto opacity-100' : 'pointer-events-none opacity-0 w-0'
  }`
  // Why: dim the children, not the root — root opacity opens a stacking context that traps the revealed strip under the worktree-level pane overlays.
  const unfocusedDimClassName = hasSplitGroups && !isFocused ? ' opacity-95' : ''
  const stripRow = (
    <div
      className={`${
        stripAutoHidden
          ? // Why: no slide during a tab drag — dnd-kit measures droppable rects once at drag start and would record the strip mid-animation.
            `absolute inset-x-0 top-0 h-[32px] border-b border-border bg-card ${
              isTabDragActive ? '' : 'transition-transform duration-150'
            } ${stripRevealed ? 'translate-y-0' : '-translate-y-full'}`
          : 'h-[32px] shrink-0 border-b border-border bg-card'
      }${unfocusedDimClassName}`}
      // Why: a drag region swallows renderer pointer events, so a revealed strip that kept one would lose the hover that holds it open.
      // Why: collapsed, the hover wrapper carries the strip identity — pane-detach drops hit-test the topmost element, and a translated-away strip is never it.
      {...(stripAutoHidden
        ? {}
        : {
            'data-terminal-focus-release-surface': 'true',
            'data-tab-group-strip-id': groupId,
            'data-worktree-id': worktreeId
          })}
      inert={stripAutoHidden && !stripRevealed}
    >
      <div className="flex h-full items-stretch pr-1.5">
        {/* Why: Electron drag hit-test respects no-drag only on DOM descendants, not z-index siblings, so this no-drag spacer keeps the collapsed left-sidebar's floating toggle clickable. */}
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
              <TabGroupPaneActionsMenu onCloseGroup={commands.closeGroup} />
            ) : null}
          </div>
        </div>
        {/* Why: Electron drag hit-test respects no-drag only on DOM descendants, not z-index siblings, so this no-drag spacer keeps the floating right-sidebar toggle + window controls clickable. */}
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
  )

  return (
    <div
      ref={panelRef}
      // Why: vertical borders stay `border-border` so the focus highlight (--accent ~#f5f5f5 in light) doesn't paint a near-white strip by the resize handle; only the bottom border changes on focus.
      // Why: unfocused split groups dim subtly so the focused one reads as selected; only when hasSplitGroups since a lone group has nothing to contrast against.
      className={`group/tab-group relative flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden${
        hasSplitGroups
          ? // Why: skip border-l/border-r on edge-touching groups; the split-layout wrapper and right sidebar already paint borders at those seams (double line otherwise).
            ` ${
              touchesLeftEdge || suppressLeftBorder ? '' : 'border-l'
            } ${touchesRightEdge || suppressRightBorder ? '' : 'border-r'} ${
              touchesBottomEdge || suppressBottomBorder ? '' : 'border-b'
            } border-border ${
              isFocused && !touchesBottomEdge && !suppressBottomBorder ? 'border-b-accent' : ''
            }`
          : ''
      }`}
      onPointerDown={commands.focusGroup}
      // Why: keyboard/AT focus can enter a split group without a pointer event, so sync group focus to DOM focus for global shortcuts.
      onFocusCapture={commands.focusGroup}
    >
      {/* Why: each split group needs its own tab row because multiple groups can show at once but the titlebar has only one shared center slot. */}
      {/* Why: macOS hiddenInset titleBarStyle makes -webkit-app-region: drag the only way to move the window from this tab row. */}
      {stripAutoHidden ? (
        // Why: while collapsed this carries the strip's identity for pane-detach drops but stays
        // click-through, so the pane keeps its own top rows until the strip actually reveals.
        <div
          className={`absolute inset-x-0 top-0 z-20 h-[32px] ${
            stripRevealed ? '' : 'pointer-events-none'
          }`}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          data-tab-group-strip-id={groupId}
          data-worktree-id={worktreeId}
        >
          {stripRow}
        </div>
      ) : (
        stripRow
      )}

      <div
        ref={setBodyDropRef}
        data-tab-group-body-id={groupId}
        data-worktree-id={worktreeId}
        className={`relative flex-1 min-h-0 overflow-hidden${unfocusedDimClassName}`}
        style={bodyAnchorStyle}
      >
        {/* Why: empty anchor so the agent-sessions tour reads as a terminal-area tip, not toolbar chrome. */}
        {isFocused ? (
          <div
            className="pointer-events-none absolute inset-x-0 top-1/4 h-px"
            data-contextual-tour-target="workspace-agent-terminal-tip"
          />
        ) : null}
        {activeTab &&
          activeTab.contentType !== 'terminal' &&
          activeTab.contentType !== 'agent-session' &&
          activeTab.contentType !== 'browser' &&
          activeTab.contentType !== 'simulator' && (
            <div className="absolute inset-0 flex min-h-0 min-w-0">
              {/* Why: split groups render editor content in a plain relative pane body, not the legacy Terminal.tsx flex column. */}
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
                <EditorPanel
                  activeFileId={activeTab.entityId}
                  activeViewStateId={activeTab.id}
                  isVisible={isVisible}
                  isCmdSaveOwner={isFocused}
                />
              </Suspense>
            </div>
          )}

        {/* Why: terminal/browser/simulator/structured-chat panes render at the worktree level; tab activation only changes overlay visibility and never remounts a live surface. */}
      </div>
    </div>
  )
}
