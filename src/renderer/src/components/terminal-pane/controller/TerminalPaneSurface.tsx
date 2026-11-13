import { TerminalRestoringPlaceholder } from '../mounting/TerminalRestoringPlaceholder'
import { TerminalCrewPortals } from '../../orchestration-crew/TerminalCrewPortals'
import { terminalPaneMenuAgentIdProps } from '../context-menu/terminal-pane-menu-agent-session-actions'
import { createPortal } from 'react-dom'
import { TerminalPaneFileDropOwners } from '../input/file-drop/TerminalPaneFileDropOwner'
import TerminalSearch from '@/components/TerminalSearch'
import { DaemonActionDialog } from '@/components/shared/useDaemonActions'
import { AgentSessionContinuationDialog } from '@/components/agent-session-continuation/AgentSessionContinuationDialog'
import { hasWorkspaceFileDragType } from '@/lib/files/drop/workspace-file-drag'
import CloseTerminalDialog from '../layout/close/CloseTerminalDialog'
import TerminalContextMenu from '../context-menu/TerminalContextMenu'
import TerminalPaneHeaderOverlay from '../titles/TerminalPaneHeaderOverlay'
import { isReattachRetryError } from '../errors/terminal-error-display'
import { TerminalErrorToast } from '../errors/TerminalErrorToast'
import { openTerminalBesideTab } from '../context-menu/open-terminal-beside-tab'
import { AgentLaunchPaneNoticePortal } from '../launch-outcome/AgentLaunchPaneNotice'
import { TerminalSessionStateSaveFailureDialog } from '../layout/persistence/TerminalSessionStateSaveFailureDialog'
import { LinkActionPopover } from '@/components/link-actions/LinkActionPopover'
import { TerminalAgentSessionForkDialog } from '../session-fork/TerminalAgentSessionForkDialog'
import { SessionRestoredBannerPortals } from '../session-restore/SessionRestoredBannerPortals'
import { handleInternalTerminalFileDrop } from '../input/file-drop/terminal-drop-handler'
import { TerminalQuickCommandEditorDialog } from '../quick-commands/TerminalQuickCommandEditorDialog'
import { TerminalPaneNativeChatPortal } from '../chat/TerminalPaneNativeChatPortal'
import { TerminalPaneSleepingPortals } from '../session-restore/spawn-deferral/TerminalPaneSleepingPortals'
import { TerminalPaneCodexRestartPortals } from './TerminalPaneCodexRestartPortals'
import { TerminalPaneMobileDriverPortals } from '../mobile-driver/TerminalPaneMobileDriverPortals'
import { TerminalPaneProcessExitPortals } from '../process-exit/TerminalPaneProcessExitPortals'
import { TerminalPaneSshReconnectPortals } from '../pty-transport/recovery/ssh/TerminalPaneSshReconnectPortals'
import { TerminalPaneRecoveryPortals } from '../pty-transport/remote-runtime/recovery/TerminalPaneRecoveryPortals'
import type { TerminalPaneController } from './use-terminal-pane-controller'
// oxfmt-ignore
import { canCloseTerminalPane, terminalPaneCloseLabel } from '../layout/close/terminal-pane-close-affordance'
import { useAppStore } from '@/store/index'
import { getKnownExecutionHostIdForWorktree } from '@/lib/workspace/ownership/worktree-runtime-owner'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host'
import { useWslHostStartCardReplacesPaneError } from '../pty-transport/recovery/wsl/use-wsl-host-stopped-pane'
import { terminalPaneMenuAddToChat } from '../clipboard/terminal-pane-menu-copy-actions'
import { useTranslate } from '@/i18n/use-translate'

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
    agentSessionContinuation,
    agentSessionFork,
    beginPaneDragFromHeader,
    chatPane,
    closeTerminalLinkActions,
    contextMenu,
    contextMenuCanContinueInNewSession,
    contextMenuCanToggleChat,
    contextMenuIsChatView,
    cwd,
    daemonActions,
    dismissTerminalError,
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
    isTabPinned,
    keybindings,
    managedPanes,
    managerRef,
    menuAgentIds,
    menuPaneHasCustomTitle,
    openDiskSpaceAnalyzer,
    openQuickCommandEditor,
    paneCount,
    paneTitleBackground,
    paneTitleOverlayRects,
    paneTitles,
    paneTransportsRef,
    pendingCloseConfirmation,
    quickCommandDraft,
    quickCommandEditorHostId,
    quickCommandEditorOpen,
    quickCommandHostLoadFailed,
    quickCommandHostOwnershipPending,
    quickCommandRepoId,
    quickCommandRepoLabel,
    renameInputRef,
    renameValue,
    renamingPaneId,
    saveQuickCommand,
    searchOpen,
    searchStateRef,
    searchInputRef,
    sessionRestoredBannerPaneIds,
    sessionStateSaveFailureMessage,
    setAgentSessionContinuation,
    setAgentSessionFork,
    setContainerRef,
    setQuickCommandEditorOpen,
    setRenameValue,
    setSearchOpen,
    setSessionStateSaveFailureMessage,
    showSplitButton,
    showSshReconnectOverlay,
    splitTerminalPaneFromHeader,
    tabId,
    terminalMountPhase,
    terminalManager,
    terminalContainerStyle,
    terminalContentVisible,
    terminalLinkActionRequest,
    titleUsesLightSurface,
    visibleQuickCommandHosts,
    visibleLaunchRefusal,
    visibleTerminalError,
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
      {/* Let SSH recovery and a stopped WSL distro's Start own the pane instead of the raw error toast. */}
      {visibleTerminalError &&
      isActive &&
      !showSshReconnectOverlay &&
      !errorReplacedByStartCard &&
      activePane
        ? createPortal(
            <TerminalErrorToast
              error={visibleTerminalError.error}
              agentId={activeAgentId}
              paneOnClient={paneOnClient}
              onDismiss={dismissTerminalError}
              onRestartDaemon={() => daemonActions.setPending('restart')}
              onRestoreTerminalFocus={() => activePane.terminal.focus()}
              onRetry={
                isReattachRetryError(visibleTerminalError.error)
                  ? () =>
                      Promise.resolve(
                        paneTransportsRef.current.get(activePane.id)?.retryRecovery?.() ?? false
                      )
                  : undefined
              }
              onOpenNewTerminal={() => void openTerminalBesideTab(tabId)}
              onClosePane={() => handleRequestClosePane(activePane.id)}
            />,
            activePane.container,
            `terminal-error-${activePane.id}`
          )
        : null}
      <TerminalPaneProcessExitPortals controller={controller} />
      <TerminalPaneSshReconnectPortals controller={controller} />
      <DaemonActionDialog api={daemonActions} />
      {isActive && (
        <TerminalSessionStateSaveFailureDialog
          open={sessionStateSaveFailureMessage !== null}
          failureMessage={sessionStateSaveFailureMessage ?? ''}
          onDismiss={() => setSessionStateSaveFailureMessage(null)}
          onOpenSpaceAnalyzer={openDiskSpaceAnalyzer}
        />
      )}
      {activePane?.container &&
        createPortal(
          <TerminalSearch
            isOpen={searchOpen}
            onClose={() => setSearchOpen(false)}
            searchAddon={activePane.searchAddon ?? null}
            searchStateRef={searchStateRef}
            inputRef={searchInputRef}
          />,
          activePane.container
        )}
      <SessionRestoredBannerPortals panes={managedPanes} paneIds={sessionRestoredBannerPaneIds} />
      <TerminalPaneNativeChatPortal controller={controller} />
      <TerminalContextMenu
        open={Boolean(terminalManager) && contextMenu.open}
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
      <LinkActionPopover
        request={terminalManager ? terminalLinkActionRequest : null}
        onClose={closeTerminalLinkActions}
      />
      {quickCommandEditorOpen ? (
        <TerminalQuickCommandEditorDialog
          command={quickCommandDraft}
          hostId={quickCommandEditorHostId}
          onOpenChange={setQuickCommandEditorOpen}
          onSave={saveQuickCommand}
        />
      ) : null}
      <TerminalAgentSessionForkDialog
        open={agentSessionFork !== null}
        fork={agentSessionFork}
        onOpenChange={(open) => {
          if (!open) {
            setAgentSessionFork(null)
          }
        }}
      />
      {agentSessionContinuation ? (
        <AgentSessionContinuationDialog
          open
          request={agentSessionContinuation}
          onOpenChange={(open) => {
            if (!open) {
              setAgentSessionContinuation(null)
            }
          }}
        />
      ) : null}
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
