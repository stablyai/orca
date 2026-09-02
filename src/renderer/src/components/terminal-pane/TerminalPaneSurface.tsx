import { createPortal } from 'react-dom'
import TerminalSearch from '@/components/TerminalSearch'
import { DaemonActionDialog } from '@/components/shared/useDaemonActions'
import { AgentSessionContinuationDialog } from '@/components/agent-session-continuation/AgentSessionContinuationDialog'
import { WORKSPACE_FILE_PATH_MIME, WORKSPACE_FILE_PATHS_MIME } from '@/lib/workspace-file-drag'
import CloseTerminalDialog from './CloseTerminalDialog'
import TerminalContextMenu from './TerminalContextMenu'
import TerminalPaneHeaderOverlay from './TerminalPaneHeaderOverlay'
import { isPaneOwnerUnverifiedError, TerminalErrorToast } from './TerminalErrorToast'
import { requestTerminalPaneRecovery } from './terminal-pane-recovery'
import { TerminalSessionStateSaveFailureDialog } from './TerminalSessionStateSaveFailureDialog'
import { TerminalLinkActionPopover } from './TerminalLinkActionPopover'
import { TerminalAgentSessionForkDialog } from './TerminalAgentSessionForkDialog'
import { SessionRestoredBannerPortals } from './SessionRestoredBannerPortals'
import { handleInternalTerminalFileDrop } from './terminal-drop-handler'
import { TerminalQuickCommandEditorDialog } from './TerminalQuickCommandEditorDialog'
import { TerminalPaneNativeChatPortal } from './TerminalPaneNativeChatPortal'
import {
  TerminalPaneCodexRestartPortals,
  TerminalPaneMobileDriverPortals,
  TerminalPaneProcessExitPortals,
  TerminalPaneRecoveryPortals,
  TerminalPaneSshReconnectPortals
} from './TerminalPaneRuntimePortals'
import type { TerminalPaneController } from './use-terminal-pane-controller'

export function TerminalPaneSurface({
  controller
}: {
  controller: TerminalPaneController
}): React.JSX.Element {
  const {
    activePane,
    activePaneCanContinueInNewSession,
    activatePaneTitleInteraction,
    agentSessionContinuation,
    agentSessionFork,
    beginPaneDragFromHeader,
    closeTerminalLinkActions,
    contextMenu,
    contextMenuCanContinueInNewSession,
    cwd,
    daemonActions,
    dismissTerminalError,
    expectedLayoutLeafIdsAttr,
    expandedPaneId,
    handleCancelClose,
    handleConfirmClose,
    handlePrimarySelectionAuxClick,
    handlePrimarySelectionMiddleMouseDown,
    handleRemoveTitle,
    handleRenameBlur,
    handleRenameCancel,
    handleRenameSubmit,
    handleRequestClosePane,
    handleStartRename,
    hiddenStartupStyle,
    isActive,
    keybindings,
    managedPanes,
    managerRef,
    menuAgentSessionId,
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
    sessionRestoredBannerPaneIds,
    sessionStateSaveFailureOpen,
    setAgentSessionContinuation,
    setAgentSessionFork,
    setContainerRef,
    setQuickCommandEditorOpen,
    setRenameValue,
    setSearchOpen,
    setSessionStateSaveFailureOpen,
    showSplitButton,
    showSshReconnectOverlay,
    splitTerminalPaneFromHeader,
    tabId,
    terminalContainerStyle,
    terminalContentVisible,
    terminalLinkActionRequest,
    titleUsesLightSurface,
    visibleQuickCommandHosts,
    visibleTerminalError,
    worktreeId
  } = controller

  return (
    <>
      <div
        ref={setContainerRef}
        className="absolute inset-0 min-h-0 min-w-0"
        data-native-file-drop-target="terminal"
        data-terminal-tab-id={tabId}
        data-terminal-layout-leaf-ids={expectedLayoutLeafIdsAttr}
        data-pane-title-surface={titleUsesLightSurface ? 'light' : 'dark'}
        style={terminalContainerStyle}
        onContextMenuCapture={contextMenu.onContextMenuCapture}
        onMouseDownCapture={handlePrimarySelectionMiddleMouseDown}
        onAuxClickCapture={handlePrimarySelectionAuxClick}
        onDragOver={(event) => {
          if (
            event.dataTransfer.types.includes(WORKSPACE_FILE_PATH_MIME) ||
            event.dataTransfer.types.includes(WORKSPACE_FILE_PATHS_MIME)
          ) {
            event.preventDefault()
            event.dataTransfer.dropEffect = 'copy'
          }
        }}
        onDrop={(event) => {
          if (
            !event.dataTransfer.types.includes(WORKSPACE_FILE_PATH_MIME) &&
            !event.dataTransfer.types.includes(WORKSPACE_FILE_PATHS_MIME)
          ) {
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
      <TerminalPaneCodexRestartPortals controller={controller} />
      {/* Why: the reconnect banner already owns SSH recovery UX; the z-50 error
          toast was painting over it (same bottom strip) with the raw ssh:connect failure. */}
      {visibleTerminalError && isActive && !showSshReconnectOverlay && activePane
        ? createPortal(
            <TerminalErrorToast
              error={visibleTerminalError}
              onDismiss={dismissTerminalError}
              onRestartDaemon={() => daemonActions.setPending('restart')}
              onRetry={
                isPaneOwnerUnverifiedError(visibleTerminalError)
                  ? () => {
                      const ptyId = activePane
                        ? (paneTransportsRef.current.get(activePane.id)?.getPtyId() ?? null)
                        : null
                      return requestTerminalPaneRecovery({
                        tabId,
                        ptyId,
                        reason: 'reattach-unverifiable'
                      }).then((recovered) => {
                        if (recovered) {
                          dismissTerminalError()
                        }
                        return recovered
                      })
                    }
                  : undefined
              }
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
          open={sessionStateSaveFailureOpen}
          onDismiss={() => setSessionStateSaveFailureOpen(false)}
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
          />,
          activePane.container
        )}
      <SessionRestoredBannerPortals
        panes={managerRef.current?.getPanes() ?? []}
        paneIds={sessionRestoredBannerPaneIds}
      />
      <TerminalPaneNativeChatPortal controller={controller} />
      <TerminalContextMenu
        open={contextMenu.open}
        onOpenChange={contextMenu.setOpen}
        menuPoint={contextMenu.point}
        menuOpenedAtRef={contextMenu.menuOpenedAtRef}
        canClosePane={contextMenu.paneCount > 1}
        canExpandPane={contextMenu.paneCount > 1}
        canEqualizePaneSizes={contextMenu.paneCount > 1 && expandedPaneId === null}
        menuPaneIsExpanded={
          contextMenu.menuPaneId !== null && contextMenu.menuPaneId === expandedPaneId
        }
        onCopy={() => void contextMenu.onCopy()}
        onSelectAll={contextMenu.onSelectAll}
        onPaste={() => void contextMenu.onPaste()}
        onSplitRight={contextMenu.onSplitRight}
        onSplitDown={contextMenu.onSplitDown}
        keybindings={keybindings}
        onEqualizePaneSizes={contextMenu.onEqualizePaneSizes}
        onClosePane={contextMenu.onClosePane}
        onClearScreen={contextMenu.onClearScreen}
        canContinueAgentSessionInNewSession={contextMenuCanContinueInNewSession}
        onContinueAgentSessionInNewSession={contextMenu.onContinueAgentSessionInNewSession}
        onForkAgentSession={() => void contextMenu.onForkAgentSession()}
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
        canCopyAgentSessionId={menuAgentSessionId !== null}
        onCopyAgentSessionId={() => void contextMenu.onCopyAgentSessionId()}
      />
      <TerminalLinkActionPopover
        request={terminalLinkActionRequest}
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
