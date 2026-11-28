import { Suspense, useState } from 'react'
import { lazyWithRetry as lazy } from '@/app-shell/startup/lazy-with-retry'
import { TerminalRestoringPlaceholder } from '../mounting/TerminalRestoringPlaceholder'
import { TerminalCrewPortals } from '../../orchestration-crew/TerminalCrewPortals'
import { terminalPaneMenuAgentIdProps } from '../context-menu/terminal-pane-menu-agent-session-actions'
import { TerminalPaneFileDropOwners } from '../input/file-drop/TerminalPaneFileDropOwner'
import { DaemonActionDialog } from '@/components/shared/useDaemonActions'
import { hasWorkspaceFileDragType } from '@/lib/files/drop/workspace-file-drag'
import CloseTerminalDialog from '../layout/close/CloseTerminalDialog'
import TerminalPaneHeaderOverlay from '../titles/TerminalPaneHeaderOverlay'
import { AgentLaunchPaneNoticePortal } from '../launch-outcome/AgentLaunchPaneNotice'
import { SessionRestoredBannerPortals } from '../session-restore/SessionRestoredBannerPortals'
import { handleInternalTerminalFileDrop } from '../input/file-drop/terminal-drop-handler'
import { TerminalPaneNativeChatPortal } from '../chat/TerminalPaneNativeChatPortal'
import { TerminalPaneSleepingPortals } from '../session-restore/spawn-deferral/TerminalPaneSleepingPortals'
import { TerminalPaneCodexRestartPortals } from './TerminalPaneCodexRestartPortals'
import { TerminalPaneMobileDriverPortals } from '../mobile-driver/TerminalPaneMobileDriverPortals'
import { TerminalPaneProcessExitPortals } from '../process-exit/TerminalPaneProcessExitPortals'
import { TerminalPaneSshReconnectPortals } from '../pty-transport/recovery/ssh/TerminalPaneSshReconnectPortals'
import { TerminalPaneRecoveryPortals } from '../pty-transport/remote-runtime/recovery/TerminalPaneRecoveryPortals'
import { TerminalPaneLazyOverlays } from './TerminalPaneLazyOverlays'
import type { TerminalPaneController } from './use-terminal-pane-controller'
// oxfmt-ignore
import { canCloseTerminalPane, terminalPaneCloseLabel } from '../layout/close/terminal-pane-close-affordance'
import { useAppStore } from '@/store/index'
import { getKnownExecutionHostIdForWorktree } from '@/lib/workspace/ownership/worktree-runtime-owner'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host/execution-host'
import { useWslHostStartCardReplacesPaneError } from '../pty-transport/recovery/wsl/use-wsl-host-stopped-pane'
import { terminalPaneMenuAddToChat } from '../clipboard/terminal-pane-menu-copy-actions'
import { useTranslate } from '@/i18n/use-translate'

const TerminalContextMenu = lazy(() => import('../context-menu/TerminalContextMenu'))

export function TerminalPaneSurface({
  controller
}: {
  controller: TerminalPaneController
}): React.JSX.Element {
  const t = useTranslate()
  const {
    activeAgentId,
    activePane,
    activePaneRuntimeEnvironmentId,
    activePaneCanContinueInNewSession,
    activePaneCanResumeInChat,
    activePaneIsChatLeaf,
    activatePaneTitleInteraction,
    beginPaneDragFromHeader,
    chatPane,
    contextMenu,
    contextMenuCanContinueInNewSession,
    contextMenuCanToggleChat,
    contextMenuIsChatView,
    cwd,
    daemonActions,
    expectedLayoutLeafIdsAttr,
    expandedPaneId,
    effectiveChatViewMode,
    handleCancelClose,
    handleConfirmClose,
    handleContextMenuToggleNativeChat,
    handlePrimarySelectionAuxClick,
    handlePrimarySelectionMiddleMouseDown,
    handleRemoveTitle,
    handleRenameBlur,
    handleRenameCancel,
    handleRenameSubmit,
    handleRequestClosePane,
    handleStartRename,
    handleToggleNativeChat,
    hiddenStartupStyle,
    isActive,
    isVisible,
    isTabPinned,
    keybindings,
    managedPanes,
    managerRef,
    menuAgentIds,
    menuPaneHasCustomTitle,
    openQuickCommandEditor,
    paneCount,
    paneTitleBackground,
    paneTitleOverlayRects,
    paneTitles,
    paneTransportsRef,
    pendingCloseConfirmation,
    quickCommandHostLoadFailed,
    quickCommandHostOwnershipPending,
    quickCommandRepoId,
    quickCommandRepoLabel,
    renameInputRef,
    renameValue,
    renamingPaneId,
    searchOpen,
    sessionRestoredBannerPaneIds,
    setContainerRef,
    setRenameValue,
    showSplitButton,
    splitTerminalPaneFromHeader,
    tabId,
    terminalMountPhase,
    terminalManager,
    terminalContainerStyle,
    terminalContentVisible,
    titleUsesLightSurface,
    visibleQuickCommandHosts,
    visibleLaunchRefusal,
    worktreeId
  } = controller
  // Why: an SSH, runtime, or not-yet-known host must not be described with this client's OS/shell.
  const paneOnClient = useAppStore(
    (state) => getKnownExecutionHostIdForWorktree(state, worktreeId) === LOCAL_EXECUTION_HOST_ID
  )
  const errorReplacedByStartCard = useWslHostStartCardReplacesPaneError(
    worktreeId,
    activePaneRuntimeEnvironmentId
  )
  const [hasOpenedSearch, setHasOpenedSearch] = useState(searchOpen)
  if (searchOpen && !hasOpenedSearch) {
    setHasOpenedSearch(true)
  }
  const [hasOpenedContextMenu, setHasOpenedContextMenu] = useState(contextMenu.open)
  if (contextMenu.open && !hasOpenedContextMenu) {
    setHasOpenedContextMenu(true)
  }

  return (
    <>
      <div
        ref={setContainerRef}
        className="absolute inset-0 min-h-0 min-w-0"
        data-terminal-tab-id={tabId}
        data-terminal-chat-view={effectiveChatViewMode && activePaneIsChatLeaf ? 'true' : undefined}
        data-terminal-chat-pane={effectiveChatViewMode && chatPane ? '' : undefined}
        data-terminal-layout-leaf-ids={expectedLayoutLeafIdsAttr}
        data-pane-title-surface={titleUsesLightSurface ? 'light' : 'dark'}
        inert={!terminalManager}
        style={
          terminalManager
            ? terminalContainerStyle
            : { ...terminalContainerStyle, visibility: 'hidden' }
        }
        onContextMenuCapture={contextMenu.onContextMenuCapture}
        onMouseDownCapture={(event) => {
          contextMenu.onMouseDownCapture(event)
          handlePrimarySelectionMiddleMouseDown(event)
        }}
        onAuxClickCapture={handlePrimarySelectionAuxClick}
        onDragOver={(event) => {
          if (hasWorkspaceFileDragType(event.dataTransfer)) {
            event.preventDefault()
            event.dataTransfer.dropEffect = 'copy'
          }
        }}
        onDrop={(event) => {
          if (!hasWorkspaceFileDragType(event.dataTransfer)) {
            return
          }
          event.preventDefault()
          event.stopPropagation()
          const manager = managerRef.current
          if (!manager) {
            return
          }
          void handleInternalTerminalFileDrop({
            manager,
            paneTransports: paneTransportsRef.current,
            worktreeId,
            tabId,
            cwd,
            dataTransfer: event.dataTransfer,
            dropTarget: event.target
          })
        }}
      />
      {terminalMountPhase === 'host' && <TerminalRestoringPlaceholder />}
      <TerminalPaneFileDropOwners controller={controller} />
      <TerminalCrewPortals controller={controller} />
      <TerminalPaneCodexRestartPortals controller={controller} />
      <AgentLaunchPaneNoticePortal
        refusal={visibleLaunchRefusal}
        agentId={activeAgentId}
        isActive={isActive}
        pane={activePane}
        tabId={tabId}
      />
      <TerminalPaneProcessExitPortals controller={controller} />
      <TerminalPaneSshReconnectPortals controller={controller} />
      {daemonActions.pending && <DaemonActionDialog api={daemonActions} />}
      <TerminalPaneLazyOverlays
        controller={controller}
        paneOnClient={paneOnClient}
        errorReplacedByStartCard={errorReplacedByStartCard}
        hasOpenedSearch={hasOpenedSearch}
      />
      <SessionRestoredBannerPortals panes={managedPanes} paneIds={sessionRestoredBannerPaneIds} />
      <TerminalPaneNativeChatPortal controller={controller} />
      {Boolean(terminalManager) && (contextMenu.open || (isActive && hasOpenedContextMenu)) ? (
        <Suspense fallback={null}>
          <TerminalContextMenu
            open={contextMenu.open}
            onOpenChange={contextMenu.setOpen}
            onRestoreTerminalFocus={contextMenu.onRestoreTerminalFocus}
            menuPoint={contextMenu.point}
            menuOpenedAtRef={contextMenu.menuOpenedAtRef}
            canClosePane={canCloseTerminalPane({
              paneCount: contextMenu.paneCount,
              showSplitButton,
              isTabPinned
            })}
            closePaneLabel={terminalPaneCloseLabel(contextMenu.paneCount, t)}
            canExpandPane={contextMenu.paneCount > 1}
            canEqualizePaneSizes={contextMenu.paneCount > 1 && expandedPaneId === null}
            menuPaneIsExpanded={
              contextMenu.menuPaneId !== null && contextMenu.menuPaneId === expandedPaneId
            }
            onCopy={() => void contextMenu.onCopy()}
            addToChat={
              contextMenu.open
                ? terminalPaneMenuAddToChat(contextMenu.menuPane, tabId, worktreeId)
                : null
            }
            onSelectAll={contextMenu.onSelectAll}
            onPaste={() => void contextMenu.onPaste()}
            onSplitRight={contextMenu.onSplitRight}
            onSplitDown={contextMenu.onSplitDown}
            keybindings={keybindings}
            onEqualizePaneSizes={contextMenu.onEqualizePaneSizes}
            onClosePane={contextMenu.onClosePane}
            onClearScreen={contextMenu.onClearScreen}
            onResetTerminal={contextMenu.onResetTerminal}
            canContinueAgentSessionInNewSession={contextMenuCanContinueInNewSession}
            onContinueAgentSessionInNewSession={contextMenu.onContinueAgentSessionInNewSession}
            onForkAgentSession={() => void contextMenu.onForkAgentSession()}
            canToggleNativeChat={contextMenuCanToggleChat}
            isNativeChatView={contextMenuIsChatView}
            onToggleNativeChat={handleContextMenuToggleNativeChat}
            onCopyAgentSessionContext={() => void contextMenu.onCopyAgentSessionContext()}
            quickCommandHosts={visibleQuickCommandHosts}
            quickCommandHostLoadFailed={quickCommandHostLoadFailed}
            quickCommandHostOwnershipPending={quickCommandHostOwnershipPending}
            quickCommandRepoLabel={quickCommandRepoLabel}
            onQuickCommand={contextMenu.onQuickCommand}
            onAddQuickCommand={(hostId) =>
              quickCommandRepoId
                ? openQuickCommandEditor({ type: 'repo', repoId: quickCommandRepoId }, hostId)
                : openQuickCommandEditor({ type: 'global' }, hostId)
            }
            onToggleExpand={contextMenu.onToggleExpand}
            onSetTitle={contextMenu.onSetTitle}
            onClearPaneTitle={contextMenu.onClearPaneTitle}
            canClearPaneTitle={menuPaneHasCustomTitle}
            onCopyTerminalId={() => void contextMenu.onCopyTerminalId()}
            onCopyPaneId={contextMenu.onCopyPaneId}
            {...terminalPaneMenuAgentIdProps(contextMenu, menuAgentIds)}
          />
        </Suspense>
      ) : null}
      {(isActive || isVisible) && (
        <TerminalPaneHeaderOverlay
          tabId={tabId}
          worktreeId={worktreeId}
          cwd={cwd ?? ''}
          showAlwaysOnHeaders={isActive && terminalContentVisible}
          showSplitButton={showSplitButton}
          isTabPinned={isTabPinned}
          paneCount={paneCount}
          activePaneId={activePane?.id}
          panes={managedPanes}
          paneTitles={paneTitles}
          paneTitleOverlayRects={paneTitleOverlayRects}
          renamingPaneId={renamingPaneId}
          renameValue={renameValue}
          renameInputRef={renameInputRef}
          titleUsesLightSurface={titleUsesLightSurface}
          paneTitleBackground={paneTitleBackground}
          terminalContentVisible={terminalContentVisible}
          hiddenStartupStyle={hiddenStartupStyle}
          managerRef={managerRef}
          paneTransportsRef={paneTransportsRef}
          canShowTerminal={activePaneIsChatLeaf}
          onShowTerminal={handleToggleNativeChat}
          canResumeInNewNativeChat={activePaneCanResumeInChat}
          canContinueAgentSessionInNewSession={activePaneCanContinueInNewSession}
          onContinueAgentSessionInNewSession={(pane) =>
            contextMenu.runForPane(pane.id, contextMenu.onContinueAgentSessionInNewSession)
          }
          onSplitPane={splitTerminalPaneFromHeader}
          onBeginPaneDrag={beginPaneDragFromHeader}
          onActivatePaneTitleInteraction={activatePaneTitleInteraction}
          onPaneTitleContextMenu={contextMenu.onPaneTitleContextMenu}
          onStartRename={handleStartRename}
          onRemoveTitle={handleRemoveTitle}
          onClosePane={handleRequestClosePane}
          onRenameValueChange={setRenameValue}
          onRenameSubmit={handleRenameSubmit}
          onRenameCancel={handleRenameCancel}
          onRenameBlur={handleRenameBlur}
        />
      )}
      <TerminalPaneRecoveryPortals controller={controller} />
      <TerminalPaneSleepingPortals controller={controller} />
      <TerminalPaneMobileDriverPortals controller={controller} />
      <CloseTerminalDialog
        open={pendingCloseConfirmation !== null}
        copyKind={pendingCloseConfirmation?.copyKind}
        onCancel={handleCancelClose}
        onConfirm={handleConfirmClose}
      />
    </>
  )
}
