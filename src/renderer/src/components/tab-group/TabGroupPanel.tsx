import { Suspense, useCallback, useMemo, useRef, type CSSProperties } from 'react'
import { lazyWithRetry as lazy } from '@/app-shell/startup/lazy-with-retry'
import { useDroppable } from '@dnd-kit/core'
import { useAppStore } from '../../store/index'
import TabBar from '../tab-bar/TabBar'

import { TabBarQuickCommandsButton } from '../tab-bar/quick-commands/TabBarQuickCommandsButton'
import { TabGroupPaneActionsMenu } from './panel/TabGroupPaneActionsMenu'
import { useTabGroupWorkspaceModel } from './workspace-model/useTabGroupWorkspaceModel'
import { closeTerminalTab } from '../terminal/tab-lifecycle/terminal-tab-actions'
import { resolveGroupTabFromVisibleId } from './workspace-model/tab-group-visible-id'
import { getTabPaneBodyDroppableId } from './drag/useTabDragSplit'
import type { HoveredTabInsertion } from './drag/tab-insertion'
import { tabGroupBodyAnchorName } from './retained-pane/tab-group-body-anchor'
import { registerTabGroupBody } from './retained-pane/tab-group-body-geometry'
import { observeTabGroupBodyGridSize } from '@/runtime/sync-runtime-graph/graph-sync-scheduler'
import { useTranslate } from '@/i18n/use-translate'
import {
  toVisibleTabType,
  type TabGroup
} from '../../../../shared/workspace-layout/tab-groups/tab-types'
import { isStructuredTab } from '../../../../shared/agent-session/view/structured-agent-session-tab'
import type { ClientHostedBrowserRow } from '../../../../shared/browser/client-hosting/client-hosted-browser-rows'
import { useClientHostedBrowserRows } from '@/runtime/browser/client-hosting/client-hosted-browser-row-state'
import { resolveClientHostedBrowserRowStripGroupId } from '../tab-bar/browser-tabs/client-hosted-browser-row-strip-placement'
import { useEditorGroupFileDropOwner } from '../editor/file-drop/use-editor-group-file-drop-owner'
import { cn } from '@/lib/class-names'
import { UNFOCUSED_SPLIT_GROUP_OPACITY } from './panel/split-group-dim'
import { useBotForWorkspace } from '../bots/bot-workspace'
import { BotPausedBanner } from '../bots/BotPausedBanner'
import { useWindowBackdropActive } from '@/app-shell/appearance/window-backdrop'
import { EditorRevealFlash } from './editor-reveal/EditorRevealFlash'
import { SplitPaneLanding } from './landing/SplitPaneLanding'
import { isSplitLandingGroup } from '@/store/slices/tabs/split-landing-groups'
import { holdTabStripPointerGestureUntilRelease } from '../tab-bar/strip/tab-strip-pointer-gesture'

const EditorPanel = lazy(() => import('../editor/EditorPanel'))
const EMPTY_GROUPS: readonly TabGroup[] = []
const EMPTY_CLIENT_HOSTED_ROWS: readonly ClientHostedBrowserRow[] = []
type SplitFocusStyle = CSSProperties &
  Record<'--tab-active-foreground' | '--tab-active-indicator', string>

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
  suppressLeftBorder = false,
  suppressRightBorder = false,
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
  markdownAnnotationsEnabled?: boolean
  touchesRightEdge: boolean
  touchesLeftEdge: boolean
  suppressLeftBorder?: boolean
  suppressRightBorder?: boolean
  reserveClosedExplorerToggleSpace: boolean
  reserveCollapsedSidebarHeaderSpace: boolean
  isTabDragActive?: boolean
  hoveredTabInsertion?: HoveredTabInsertion | null
}): React.JSX.Element {
  const t = useTranslate()
  const rightSidebarOpen = useAppStore((state) => state.rightSidebarOpen)
  const sidebarOpen = useAppStore((state) => state.sidebarOpen)
  const reserveRightTitlebarSpace = reserveClosedExplorerToggleSpace && !rightSidebarOpen
  const model = useTabGroupWorkspaceModel({ groupId, worktreeId })
  const bot = useBotForWorkspace(reserveClosedExplorerToggleSpace ? worktreeId : null)
  const quickCommandsSlotRef = useRef<HTMLDivElement>(null)
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
  const bodyAnchorName = tabGroupBodyAnchorName(groupId)
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
          : activeTab && toVisibleTabType(activeTab.contentType) === 'agent-session'
            ? activeTab.id
            : null
      }
      groupId={groupId}
      isFocused={isFocused}
      onCloseSplitPane={hasSplitGroups ? commands.closeGroup : undefined}
      worktreeId={worktreeId}
      expandedPaneByTabId={model.expandedPaneByTabId}
      onActivate={commands.activateTerminal}
      onClose={(terminalId) => {
        const item = resolveGroupTabFromVisibleId(model.groupTabs, terminalId)
        if (
          item?.contentType === 'terminal' ||
          item?.contentType === 'agent-session' ||
          item?.contentType === 'room'
        ) {
          commands.closeItem(item.id)
          return
        }
        closeTerminalTab(terminalId, { reason: 'user' })
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
      clientHostedBrowserRows={clientHostedRows}
      groupActiveTabId={activeTab?.id ?? null}
      agentSessionTabs={agentSessionItems}
      activeFileId={
        activeTab && toVisibleTabType(activeTab.contentType) !== 'editor' ? null : activeTab?.id
      }
      activeBrowserTabId={activeTab?.contentType === 'browser' ? activeTab.entityId : null}
      activeSimulatorTabId={activeTab?.contentType === 'simulator' ? activeTab.id : null}
      activeTabType={activeTab ? toVisibleTabType(activeTab.contentType) : 'editor'}
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

  const actionChromeClassName = cn(
    'flex min-w-0 items-center gap-0.5 overflow-hidden pl-1.5 pr-0.5 transition-opacity duration-150',
    !isFocused && 'opacity-50 hover:opacity-100 focus-within:opacity-100'
  )
  const splitFocusStyle: SplitFocusStyle | undefined =
    hasSplitGroups && !isFocused
      ? {
          ...(backdropActive ? {} : { opacity: UNFOCUSED_SPLIT_GROUP_OPACITY }),
          '--tab-active-foreground': 'var(--muted-foreground)',
          '--tab-active-indicator': 'var(--muted-foreground)'
        }
      : undefined
  const holdTabStripPointerGesture = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return
    }
    const targetWindow = event.currentTarget.ownerDocument.defaultView
    if (!targetWindow) {
      return
    }
    holdTabStripPointerGestureUntilRelease(targetWindow, event.pointerId)
  }, [])
  return (
    <div
      data-unfocused-split-group={hasSplitGroups && !isFocused ? '' : undefined}
      data-split-group={hasSplitGroups ? '' : undefined}
      className={`group/tab-group relative flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden${
        hasSplitGroups
          ? ` ${touchesLeftEdge || suppressLeftBorder ? '' : 'border-l'} ${touchesRightEdge || suppressRightBorder ? '' : 'border-r'} border-border`
          : ''
      }`}
      style={splitFocusStyle}
      onPointerDown={commands.focusGroup}
      onFocusCapture={commands.focusGroup}
    >
      {tabStrip !== 'attached' ? null : (
        <div
          className="h-(--workspace-tab-row-height) shrink-0 border-b border-border bg-tab-bar"
          data-tab-group-strip-id={groupId}
          data-terminal-focus-release-surface="true"
          data-worktree-id={worktreeId}
          onPointerDownCapture={holdTabStripPointerGesture}
        >
          <div className="flex h-full items-stretch pr-1">
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
            <div className="@container/tab-strip group/tab-strip-row flex min-w-0 flex-1 items-stretch">
              <div className="min-w-10 flex-1 h-full">{tabBar}</div>
              {reserveRightTitlebarSpace ? (
                <div className="workspace-tab-drag-handle w-10 min-w-0 @max-[203px]/tab-strip:hidden group-has-[[data-pinned-home-with-strip]]/tab-strip-row:@max-[243px]/tab-strip:hidden" />
              ) : null}
              <div
                className={actionChromeClassName}
                style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
              >
                <div
                  ref={quickCommandsSlotRef}
                  className="contents @max-[163px]/tab-strip:invisible @max-[163px]/tab-strip:absolute @max-[163px]/tab-strip:end-0 @max-[163px]/tab-strip:top-0 @max-[163px]/tab-strip:block group-has-[[data-pinned-home-with-strip]]/tab-strip-row:@max-[203px]/tab-strip:invisible group-has-[[data-pinned-home-with-strip]]/tab-strip-row:@max-[203px]/tab-strip:absolute group-has-[[data-pinned-home-with-strip]]/tab-strip-row:@max-[203px]/tab-strip:end-0 group-has-[[data-pinned-home-with-strip]]/tab-strip-row:@max-[203px]/tab-strip:top-0 group-has-[[data-pinned-home-with-strip]]/tab-strip-row:@max-[203px]/tab-strip:block"
                >
                  <TabBarQuickCommandsButton
                    worktreeId={worktreeId}
                    groupId={groupId}
                    isFocused={isFocused}
                  />
                </div>
                {hasSplitGroups ? (
                  <div className="contents @max-[114px]/tab-strip:hidden group-has-[[data-pinned-home-with-strip]]/tab-strip-row:@max-[154px]/tab-strip:hidden">
                    <TabGroupPaneActionsMenu
                      isFocused={isFocused}
                      onCloseGroup={commands.closeGroup}
                      worktreeId={worktreeId}
                      groupId={groupId}
                      quickCommandsSlotRef={quickCommandsSlotRef}
                    />
                  </div>
                ) : null}
              </div>
            </div>
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

      {bot?.paused ? <BotPausedBanner bot={bot} /> : null}
      <div
        ref={setBodyRef}
        data-tab-group-body-id={groupId}
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
        {isFocused ? (
          <div
            className="pointer-events-none absolute inset-x-0 top-1/4 h-px"
            data-contextual-tour-target="workspace-agent-terminal-tip"
            data-active-content-type={activeTab?.contentType}
          />
        ) : null}
        {activeTab && toVisibleTabType(activeTab.contentType) === 'editor' && (
          <div ref={attachEditorFileDropOwner} className="absolute inset-0 flex min-h-0 min-w-0">
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
      </div>
    </div>
  )
}
