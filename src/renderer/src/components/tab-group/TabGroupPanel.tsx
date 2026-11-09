import { Suspense, useCallback, useMemo } from 'react'
import { lazyWithRetry as lazy } from '@/app-shell/startup/lazy-with-retry'
import { useDroppable } from '@dnd-kit/core'
import { useAppStore } from '../../store/index'
import TabBar from '../tab-bar/TabBar'
import { TabSidePanel } from './TabSidePanel'
import { useTabSidePanelEnabled } from './use-tab-side-panel-enabled'

import { TabGroupStripActions } from './TabGroupStripActions'
import { useTabGroupWorkspaceModel } from './useTabGroupWorkspaceModel'
import { closeTerminalTab } from '../terminal/terminal-tab-actions'
import { resolveGroupTabFromVisibleId } from './tab-group-visible-id'
import { getTabPaneBodyDroppableId, type HoveredTabInsertion } from './useTabDragSplit'
import { tabGroupBodyAnchorName } from './tab-group-body-anchor'
import { registerTabGroupBody } from './tab-group-body-geometry'
import { observeTabGroupBodyGridSize } from '@/runtime/sync-runtime-graph/graph-sync-scheduler'
import { useTranslate } from '@/i18n/use-translate'
import type { TabGroup } from '../../../../shared/tab-types'
import { TAB_STRIP_ORIENTATION } from '../tab-bar/tab-strip-orientation'
import { isStructuredTab } from '../../../../shared/agent-session/view/structured-agent-session-tab'
import type { ClientHostedBrowserRow } from '../../../../shared/client-hosted-browser-rows'
import { useClientHostedBrowserRows } from '@/runtime/browser/client-hosting/client-hosted-browser-row-state'
import { resolveClientHostedBrowserRowStripGroupId } from '../tab-bar/client-hosted-browser-row-strip-placement'
import { useEditorGroupFileDropOwner } from '../editor/use-editor-group-file-drop-owner'
import { cn } from '@/lib/class-names'
import { UNFOCUSED_SPLIT_GROUP_OPACITY } from './split-group-dim'
import { useWindowBackdropActive } from '@/app-shell/appearance/window-backdrop'
import { EditorRevealFlash } from './EditorRevealFlash'
import { SplitPaneLanding } from './SplitPaneLanding'
import { isSplitLandingGroup } from '@/store/slices/tabs/split-landing-groups'

const EditorPanel = lazy(() => import('../editor/EditorPanel'))
const EMPTY_GROUPS: readonly TabGroup[] = []
const EMPTY_CLIENT_HOSTED_ROWS: readonly ClientHostedBrowserRow[] = []

/** The panel draws attached strips; external hosts provide their single strip in shell chrome. */
export type TabGroupPanelTabStrip = 'attached' | 'external'

export default function TabGroupPanel({
  groupId,
  worktreeId,
  isVisible,
  isFocused,
  hasSplitGroups,
  tabStrip = 'attached',
  markdownAnnotationsEnabled = true,
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
  tabStrip?: TabGroupPanelTabStrip
  /** Off for scratch workspaces (the floating panel) whose markdown is not a review surface. */
  markdownAnnotationsEnabled?: boolean
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
  const t = useTranslate()
  const rightSidebarOpen = useAppStore((state) => state.rightSidebarOpen)
  // Floating panels keep their external strip: they have no room for a side column.
  const usesSidePanel = useTabSidePanelEnabled(tabStrip === 'attached')
  const sidebarOpen = useAppStore((state) => state.sidebarOpen)
  const reserveRightTitlebarSpace = reserveClosedExplorerToggleSpace && !rightSidebarOpen
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
  const showsSplitLanding = useAppStore((state) =>
    isSplitLandingGroup(state, worktreeId, model.group ?? undefined)
  )
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
  const { setNodeRef: setBodyDropRef } = useDroppable({
    id: getTabPaneBodyDroppableId(groupId),
    data: {
      kind: 'pane-body',
      groupId,
      worktreeId
    },
    disabled: !isTabDragActive
  })
  const setBodyRef = useCallback(
    (node: HTMLDivElement | null) => {
      setBodyDropRef(node)
      if (!node) {
        return undefined
      }
      const unregisterBody = registerTabGroupBody(groupId, node)
      const stopGridSizeReport = observeTabGroupBodyGridSize(node)
      return () => {
        unregisterBody()
        stopGridSizeReport()
        setBodyDropRef(null)
      }
    },
    [groupId, setBodyDropRef]
  )
  const attachEditorFileDropOwner = useEditorGroupFileDropOwner({ worktreeId, groupId })
  const backdropActive = useWindowBackdropActive()
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
      onCloseSplitPane={hasSplitGroups ? commands.closeGroup : undefined}
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
        closeTerminalTab(terminalId, { reason: 'user' })
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
      orientation={
        usesSidePanel ? TAB_STRIP_ORIENTATION.vertical : TAB_STRIP_ORIENTATION.horizontal
      }
    />
  )

  return (
    <div
      // Dim unfocused splits only when siblings exist; keep vertical seams neutral and change only the bottom focus border.
      // Why grid over a wrapper: split geometry reads the panel as the body's parent, and toggling must not remount the body.
      className={`group/tab-group relative ${
        usesSidePanel
          ? 'grid grid-cols-[minmax(0,1fr)_auto] grid-rows-[32px_minmax(0,1fr)]'
          : 'flex flex-col'
      } flex-1 min-w-0 min-h-0 overflow-hidden${
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
      // Why not over a window backdrop (material or theme image): group opacity would let it bleed through opaque chrome.
      style={
        hasSplitGroups && !isFocused && !backdropActive
          ? { opacity: UNFOCUSED_SPLIT_GROUP_OPACITY }
          : undefined
      }
      onPointerDown={commands.focusGroup}
      // Why: keyboard/AT focus can enter a split group without a pointer event, so sync group focus to DOM focus for global shortcuts.
      onFocusCapture={commands.focusGroup}
    >
      {/* Each visible split needs its own strip; the shared titlebar cannot represent them all. */}
      {/* Omit external strips entirely because hidden duplicates would still register competing drag sortables. */}
      {tabStrip !== 'attached' ? null : (
        <div
          className={cn(
            'h-[32px] shrink-0 border-b border-border bg-tab-bar',
            usesSidePanel && 'col-span-2'
          )}
          data-tab-group-strip-id={usesSidePanel ? undefined : groupId}
          data-terminal-focus-release-surface="true"
          data-worktree-id={worktreeId}
        >
          <div className="flex h-full items-stretch pr-1">
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
            {/* Why: the tab-strip container excludes the reserved spacers, so width rules see only the room tabs and actions share. */}
            <div className="@container/tab-strip flex min-w-0 flex-1 items-stretch">
              <div className="min-w-10 flex-1 h-full">{usesSidePanel ? null : tabBar}</div>
              {/* Why: overflowing tabs eat all strip whitespace; keep a window-drag handle while the right sidebar header is closed. It goes first in narrow strips: 203 = 40 gap + 163 for the tab floor and every control, so controls never clip behind it. */}
              {reserveRightTitlebarSpace ? (
                <div className="w-10 min-w-0 @max-[203px]/tab-strip:hidden" />
              ) : null}
              <TabGroupStripActions
                worktreeId={worktreeId}
                groupId={groupId}
                isFocused={isFocused}
                hasSplitGroups={hasSplitGroups}
                onCloseGroup={commands.closeGroup}
              />
            </div>
            {/* Why: Electron drag hit-test respects no-drag only on DOM descendants, not z-index siblings, so this no-drag spacer keeps the floating right-sidebar toggle + window controls clickable. */}
            {reserveRightTitlebarSpace ? (
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
      )}

      <div
        ref={setBodyRef}
        data-tab-group-body-id={groupId}
        // Why: the pane overlays paint terminals and chats above this body; only they show the backdrop.
        data-translucent-tab-body={
          activeTab?.contentType === 'terminal' ||
          (activeTab && isStructuredTab(activeTab) && backdropActive)
            ? ''
            : undefined
        }
        data-worktree-id={worktreeId}
        className="relative flex-1 min-h-0 overflow-hidden"
        style={bodyAnchorStyle}
      >
        {/* Why: empty anchor so the agent-sessions tour reads as a terminal-area tip, not toolbar chrome. */}
        {isFocused ? (
          <div
            className="pointer-events-none absolute inset-x-0 top-1/4 h-px"
            data-contextual-tour-target="workspace-agent-terminal-tip"
            // Picks the chat or terminal split step of the agent-sessions tour.
            data-active-content-type={activeTab?.contentType}
          />
        ) : null}
        {activeTab &&
          activeTab.contentType !== 'terminal' &&
          activeTab.contentType !== 'agent-session' &&
          activeTab.contentType !== 'browser' &&
          activeTab.contentType !== 'simulator' && (
            // Why: a capture-phase owner, so Monaco never sees the drop and the file opens as a tab here.
            <div ref={attachEditorFileDropOwner} className="absolute inset-0 flex min-h-0 min-w-0">
              {/* Why: split groups render editor content in a plain relative pane body, not the legacy Terminal.tsx flex column. */}
              <Suspense
                fallback={
                  <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                    {t('auto.components.tab.group.TabGroupPanel.814fb04c43', 'Loading editor...')}
                  </div>
                }
              >
                <EditorPanel
                  activeFileId={activeTab.entityId}
                  activeViewStateId={activeTab.id}
                  isVisible={isVisible}
                  isCmdSaveOwner={isFocused}
                  markdownAnnotationsEnabled={markdownAnnotationsEnabled}
                />
              </Suspense>
              <EditorRevealFlash viewStateId={activeTab.id} />
            </div>
          )}

        {showsSplitLanding ? (
          <SplitPaneLanding
            worktreeId={worktreeId}
            groupId={groupId}
            autoFocus={isFocused}
            onClosePane={hasSplitGroups ? commands.closeGroup : undefined}
          />
        ) : null}

        {/* Why: terminal/browser/simulator/structured-chat panes render at the worktree level; tab activation only changes overlay visibility and never remounts a live surface. */}
      </div>
      {usesSidePanel ? (
        <TabSidePanel groupId={groupId} worktreeId={worktreeId}>
          {tabBar}
        </TabSidePanel>
      ) : null}
    </div>
  )
}
