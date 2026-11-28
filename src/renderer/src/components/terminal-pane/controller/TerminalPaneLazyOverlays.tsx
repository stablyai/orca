import { Suspense } from 'react'
import { createPortal } from 'react-dom'
import { lazyWithRetry as lazy } from '@/app-shell/startup/lazy-with-retry'
import { isPaneOwnerRecoveryError } from '../errors/terminal-error-display'
import { openTerminalBesideTab } from '../context-menu/open-terminal-beside-tab'
import type { TerminalPaneController } from './use-terminal-pane-controller'

const TerminalSearch = lazy(() => import('@/components/terminal-pane/search/TerminalSearch'))
const AgentSessionContinuationDialog = lazy(() =>
  import('@/components/agent-session-continuation/AgentSessionContinuationDialog').then(
    (module) => ({ default: module.AgentSessionContinuationDialog })
  )
)
const TerminalErrorToast = lazy(() =>
  import('../errors/TerminalErrorToast').then((module) => ({
    default: module.TerminalErrorToast
  }))
)
const TerminalSessionStateSaveFailureDialog = lazy(() =>
  import('../layout/persistence/TerminalSessionStateSaveFailureDialog').then((module) => ({
    default: module.TerminalSessionStateSaveFailureDialog
  }))
)
const LinkActionPopover = lazy(() =>
  import('@/components/link-actions/LinkActionPopover').then((module) => ({
    default: module.LinkActionPopover
  }))
)
const TerminalAgentSessionForkDialog = lazy(() =>
  import('../session-fork/TerminalAgentSessionForkDialog').then((module) => ({
    default: module.TerminalAgentSessionForkDialog
  }))
)
const TerminalQuickCommandEditorDialog = lazy(() =>
  import('../quick-commands/TerminalQuickCommandEditorDialog').then((module) => ({
    default: module.TerminalQuickCommandEditorDialog
  }))
)

export function TerminalPaneLazyOverlays({
  controller,
  paneOnClient,
  errorReplacedByStartCard,
  hasOpenedSearch
}: {
  controller: TerminalPaneController
  paneOnClient: boolean
  errorReplacedByStartCard: boolean
  hasOpenedSearch: boolean
}): React.JSX.Element {
  const {
    activeAgentId,
    activePane,
    agentSessionContinuation,
    agentSessionFork,
    closeTerminalLinkActions,
    daemonActions,
    dismissTerminalError,
    handleRequestClosePane,
    isActive,
    openDiskSpaceAnalyzer,
    paneTransportsRef,
    quickCommandDraft,
    quickCommandEditorHostId,
    quickCommandEditorOpen,
    saveQuickCommand,
    searchInputRef,
    searchOpen,
    searchStateRef,
    sessionStateSaveFailureMessage,
    setAgentSessionContinuation,
    setAgentSessionFork,
    setQuickCommandEditorOpen,
    setSearchOpen,
    setSessionStateSaveFailureMessage,
    showSshReconnectOverlay,
    tabId,
    terminalLinkActionRequest,
    terminalManager,
    visibleTerminalError
  } = controller

  return (
    <>
      {/* Let SSH recovery and a stopped WSL distro's Start own the pane instead of the raw error toast. */}
      {visibleTerminalError &&
      isActive &&
      !showSshReconnectOverlay &&
      !errorReplacedByStartCard &&
      activePane
        ? createPortal(
            <Suspense fallback={null}>
              <TerminalErrorToast
                error={visibleTerminalError.error}
                agentId={activeAgentId}
                paneOnClient={paneOnClient}
                onDismiss={dismissTerminalError}
                onRestartDaemon={() => daemonActions.setPending('restart')}
                onRestoreTerminalFocus={() => activePane.terminal.focus()}
                onRetry={
                  isPaneOwnerRecoveryError(visibleTerminalError.error)
                    ? () =>
                        Promise.resolve(
                          paneTransportsRef.current.get(activePane.id)?.retryRecovery?.() ?? false
                        )
                    : undefined
                }
                onOpenNewTerminal={() => void openTerminalBesideTab(tabId)}
                onClosePane={() => handleRequestClosePane(activePane.id)}
              />
            </Suspense>,
            activePane.container,
            `terminal-error-${activePane.id}`
          )
        : null}
      {isActive && sessionStateSaveFailureMessage !== null && (
        <Suspense fallback={null}>
          <TerminalSessionStateSaveFailureDialog
            open
            failureMessage={sessionStateSaveFailureMessage}
            onDismiss={() => setSessionStateSaveFailureMessage(null)}
            onOpenSpaceAnalyzer={openDiskSpaceAnalyzer}
          />
        </Suspense>
      )}
      {activePane?.container &&
        (searchOpen || hasOpenedSearch) &&
        createPortal(
          <Suspense fallback={null}>
            <TerminalSearch
              isOpen={searchOpen}
              onClose={() => setSearchOpen(false)}
              searchAddon={activePane.searchAddon ?? null}
              searchStateRef={searchStateRef}
              inputRef={searchInputRef}
            />
          </Suspense>,
          activePane.container
        )}
      {terminalManager && terminalLinkActionRequest && (
        <Suspense fallback={null}>
          <LinkActionPopover
            request={terminalLinkActionRequest}
            onClose={(dismissed) =>
              closeTerminalLinkActions(dismissed ? terminalLinkActionRequest : undefined)
            }
          />
        </Suspense>
      )}
      {quickCommandEditorOpen && (
        <Suspense fallback={null}>
          <TerminalQuickCommandEditorDialog
            command={quickCommandDraft}
            hostId={quickCommandEditorHostId}
            onOpenChange={setQuickCommandEditorOpen}
            onSave={saveQuickCommand}
          />
        </Suspense>
      )}
      {agentSessionFork && (
        <Suspense fallback={null}>
          <TerminalAgentSessionForkDialog
            open
            fork={agentSessionFork}
            onOpenChange={(open) => !open && setAgentSessionFork(null)}
          />
        </Suspense>
      )}
      {agentSessionContinuation && (
        <Suspense fallback={null}>
          <AgentSessionContinuationDialog
            open
            request={agentSessionContinuation}
            onOpenChange={(open) => !open && setAgentSessionContinuation(null)}
          />
        </Suspense>
      )}
    </>
  )
}
