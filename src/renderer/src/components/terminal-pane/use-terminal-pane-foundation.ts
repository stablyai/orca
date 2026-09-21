import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { IDisposable } from '@xterm/xterm'
import { useAppStore } from '../../store'
import { hydrateRuntimeEnvironmentSshState } from '@/runtime/runtime-environment-ssh-state'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'
import type { TerminalKittyKeyboardModeTracker } from '../../../../shared/terminal-kitty-keyboard-mode-tracker'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from './pty-transport'
import type { SearchState } from './keyboard-handlers'
import type { CloseTerminalDialogCopyKind } from './CloseTerminalDialog'
import type { TerminalLinkActionRequest } from './terminal-link-action-request'
import { closeTerminalLinkActionRequest } from './terminal-link-action-request'
import type { PreparedAgentSessionFork } from './terminal-agent-session-fork'
import type { AgentSessionContinuationRequest } from '@/lib/agent-session-continuation'
import { createTerminalQuickCommandDraft } from '@/components/terminal-quick-commands/TerminalQuickCommandDialog'
import { useDaemonActions } from '@/components/shared/useDaemonActions'
import { useMobileOverlayTicks } from './use-mobile-overlay-ticks'
import type { TerminalPaneHandle, TerminalPaneProps } from './terminal-pane-types'
import { useVisibleTerminalTabClaim } from './use-visible-terminal-tab-claim'
import type { VisiblePtyRecoveryState } from './terminal-remote-runtime-recovery-ui-state'
import type { PaneProcessExit } from './pty-connection-types'
import type { PaneCwdMap } from './resolve-split-cwd'
import type { TerminalErrorsByPaneId } from './terminal-error-accumulation'
import { selectTerminalPaneHostState } from './terminal-pane-host-state'

export function useTerminalPaneFoundation(
  props: TerminalPaneProps,
  ref: React.ForwardedRef<TerminalPaneHandle>
) {
  const {
    tabId,
    worktreeId,
    cwd,
    isActive,
    isVisible = true,
    isWorktreeActive = isVisible,
    isolatedPaneKey = null,
    showSplitButton = true,
    onPtyExit,
    onCloseTab
  } = props
  const containerRef = useRef<HTMLDivElement>(null)
  const managerRef = useRef<PaneManager | null>(null)
  const paneFontSizesRef = useRef<Map<number, number>>(new Map())
  const expandedPaneIdRef = useRef<number | null>(null)
  const expandedStyleSnapshotRef = useRef<Map<HTMLElement, { display: string; flex: string }>>(
    new Map()
  )
  const pendingPaneSizeRefreshFrameIdsRef = useRef<number[]>([])
  const activityIsolationSnapshotRef = useRef<Map<HTMLElement, { display: string; flex: string }>>(
    new Map()
  )
  const paneTransportsRef = useRef<Map<number, PtyTransport>>(new Map())
  const paneCwdRef = useRef<PaneCwdMap>(new Map())
  const paneMode2031Ref = useRef<Map<number, boolean>>(new Map())
  const paneKittyKeyboardModesRef = useRef<Map<number, TerminalKittyKeyboardModeTracker>>(new Map())
  const paneLastThemeModeRef = useRef<Map<number, 'dark' | 'light'>>(new Map())
  const panePtyBindingsRef = useRef<Map<number, IDisposable>>(new Map())
  const replayingPanesRef = useRef<Map<number, number>>(new Map())
  const isActiveRef = useRef(isActive)
  // Event/PTY callbacks need current visibility before passive effects run.
  // react-doctor-disable-next-line react-doctor/no-ref-current-in-render
  isActiveRef.current = isActive
  const isRendererVisible = isVisible && isWorktreeActive
  const isVisibleRef = useRef(isRendererVisible)
  // react-doctor-disable-next-line react-doctor/no-ref-current-in-render
  isVisibleRef.current = isRendererVisible
  const {
    nativeChatTranscriptIsLocalReadable,
    sshReconnectEnvironmentId,
    sshReconnectError,
    sshReconnectStatus,
    sshReconnectTargetId,
    sshReconnectTargetLabel,
    sshReconnectTargetRemoved
  } = useAppStore(useShallow((store) => selectTerminalPaneHostState(store, worktreeId)))
  const sshReconnectOwnsTerminalErrors = Boolean(
    sshReconnectTargetId && sshReconnectStatus && sshReconnectStatus !== 'connected'
  )
  const sshReconnectOwnsTerminalErrorsRef = useRef(sshReconnectOwnsTerminalErrors)
  useLayoutEffect(() => {
    sshReconnectOwnsTerminalErrorsRef.current = sshReconnectOwnsTerminalErrors
  }, [sshReconnectOwnsTerminalErrors])
  useEffect(() => {
    if (!sshReconnectEnvironmentId) {
      return
    }
    void hydrateRuntimeEnvironmentSshState(sshReconnectEnvironmentId).catch(() => {})
  }, [sshReconnectEnvironmentId])

  useVisibleTerminalTabClaim({ isVisible, tabId })
  const [expandedPaneId, setExpandedPaneId] = useState<number | null>(null)
  const [paneCount, setPaneCount] = useState<number>(0)
  const [paneLayoutRevision, setPaneLayoutRevision] = useState(0)
  const [terminalLinkActionRequest, setTerminalLinkActionRequest] =
    useState<TerminalLinkActionRequest | null>(null)
  const requestTerminalLinkAction = useCallback((request: TerminalLinkActionRequest) => {
    setTerminalLinkActionRequest(request)
  }, [])
  const closeTerminalLinkActions = useCallback((dismissed?: TerminalLinkActionRequest) => {
    setTerminalLinkActionRequest((current) => closeTerminalLinkActionRequest(current, dismissed))
  }, [])
  const [searchOpen, setSearchOpen] = useState(false)
  const searchOpenRef = useRef(false)
  // Keyboard callbacks must observe current search state immediately.
  // react-doctor-disable-next-line react-doctor/no-ref-current-in-render
  searchOpenRef.current = searchOpen
  const searchStateRef = useRef<SearchState>({
    query: '',
    caseSensitive: false,
    regex: false
  })
  const [pendingCloseConfirmation, setPendingCloseConfirmation] = useState<{
    paneId: number
    copyKind: CloseTerminalDialogCopyKind
  } | null>(null)
  const [quickCommandEditorOpen, setQuickCommandEditorOpen] = useState(false)
  const [quickCommandEditorHostId, setQuickCommandEditorHostId] =
    useState<ExecutionHostId>(LOCAL_EXECUTION_HOST_ID)
  const [chatLeafId, setChatLeafId] = useState<string | null>(null)
  const onAgentExitedRef = useRef<(leafId: string) => void>(() => {})
  const [tabWideAgentHintLeafId, setTabWideAgentHintLeafId] = useState<string | null | undefined>(
    undefined
  )
  const [quickCommandDraft, setQuickCommandDraft] = useState(createTerminalQuickCommandDraft)
  const [agentSessionFork, setAgentSessionFork] = useState<PreparedAgentSessionFork | null>(null)
  const [agentSessionContinuation, setAgentSessionContinuation] =
    useState<AgentSessionContinuationRequest | null>(null)
  const [terminalError, setTerminalError] = useState<string | null>(null)
  const [terminalErrorsByPaneId, setTerminalErrorsByPaneId] = useState<TerminalErrorsByPaneId>({})
  const [paneProcessExitsByPaneId, setPaneProcessExitsByPaneId] = useState<
    Record<number, PaneProcessExit>
  >({})
  const handlePaneProcessDied = useCallback((processExit: PaneProcessExit) => {
    setPaneProcessExitsByPaneId((current) => ({
      ...current,
      [processExit.paneId]: processExit
    }))
  }, [])
  const [ptyRecoveryStatesByPaneId, setPtyRecoveryStatesByPaneId] = useState<
    Record<number, VisiblePtyRecoveryState>
  >({})
  const [sessionStateSaveFailureOpen, setSessionStateSaveFailureOpen] = useState(false)
  const daemonActions = useDaemonActions()
  const { refreshMobileOverlays } = useMobileOverlayTicks({
    managerRef,
    paneTransportsRef
  })

  return {
    ...props,
    ref,
    tabId,
    worktreeId,
    cwd,
    isActive,
    isVisible,
    isWorktreeActive,
    isolatedPaneKey,
    showSplitButton,
    onPtyExit,
    onCloseTab,
    containerRef,
    managerRef,
    paneFontSizesRef,
    expandedPaneIdRef,
    expandedStyleSnapshotRef,
    pendingPaneSizeRefreshFrameIdsRef,
    activityIsolationSnapshotRef,
    paneTransportsRef,
    paneCwdRef,
    paneMode2031Ref,
    paneKittyKeyboardModesRef,
    paneLastThemeModeRef,
    panePtyBindingsRef,
    replayingPanesRef,
    isActiveRef,
    isRendererVisible,
    isVisibleRef,
    sshReconnectTargetId,
    nativeChatTranscriptIsLocalReadable,
    sshReconnectEnvironmentId,
    sshReconnectError,
    sshReconnectStatus,
    sshReconnectTargetLabel,
    sshReconnectTargetRemoved,
    sshReconnectOwnsTerminalErrors,
    sshReconnectOwnsTerminalErrorsRef,
    expandedPaneId,
    setExpandedPaneId,
    paneCount,
    setPaneCount,
    paneLayoutRevision,
    setPaneLayoutRevision,
    terminalLinkActionRequest,
    requestTerminalLinkAction,
    closeTerminalLinkActions,
    searchOpen,
    setSearchOpen,
    searchOpenRef,
    searchStateRef,
    pendingCloseConfirmation,
    setPendingCloseConfirmation,
    quickCommandEditorOpen,
    setQuickCommandEditorOpen,
    quickCommandEditorHostId,
    setQuickCommandEditorHostId,
    chatLeafId,
    setChatLeafId,
    onAgentExitedRef,
    tabWideAgentHintLeafId,
    setTabWideAgentHintLeafId,
    quickCommandDraft,
    setQuickCommandDraft,
    agentSessionFork,
    setAgentSessionFork,
    agentSessionContinuation,
    setAgentSessionContinuation,
    terminalError,
    terminalErrorsByPaneId,
    setTerminalErrorsByPaneId,
    paneProcessExitsByPaneId,
    setPaneProcessExitsByPaneId,
    handlePaneProcessDied,
    setTerminalError,
    ptyRecoveryStatesByPaneId,
    setPtyRecoveryStatesByPaneId,
    sessionStateSaveFailureOpen,
    setSessionStateSaveFailureOpen,
    daemonActions,
    refreshMobileOverlays
  }
}

export type TerminalPaneFoundation = ReturnType<typeof useTerminalPaneFoundation>
