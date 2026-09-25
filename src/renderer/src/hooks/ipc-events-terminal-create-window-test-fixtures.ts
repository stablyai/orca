import { vi } from 'vitest'
import type { SleepingAgentLaunchConfig } from '../../../shared/agent-session-resume'
import type { TuiAgent } from '../../../shared/tui-agent'

type ListenerRef = { current: unknown }

// Why: the preload surface the terminal-create scenario stubs is large enough that
// inlining it would push the scenario test past the file-length budget.
export function buildTerminalCreateWindow(args: {
  dispatchEvent: unknown
  replyTerminalCreate: unknown
  createTerminalListenerRef: ListenerRef
  requestTerminalCreateListenerRef: ListenerRef
  focusTerminalListenerRef: ListenerRef
  newTerminalTabListenerRef: ListenerRef
}): Record<string, unknown> {
  const {
    dispatchEvent,
    replyTerminalCreate,
    createTerminalListenerRef,
    requestTerminalCreateListenerRef,
    focusTerminalListenerRef,
    newTerminalTabListenerRef
  } = args
  return {
    dispatchEvent,
    api: {
      repos: { onChanged: () => () => {} },
      automations: { onChanged: () => () => {} },
      worktrees: {
        onChanged: () => () => {},
        onBaseStatus: () => () => {},
        onRemoteBranchConflict: () => () => {}
      },
      ui: {
        onStateChanged: () => () => {},
        onOpenSettings: () => () => {},
        consumePendingOpenSettings: () => Promise.resolve(false),
        onOpenFeatureTour: () => () => {},
        onToggleLeftSidebar: () => () => {},
        onToggleRightSidebar: () => () => {},
        onToggleWorktreePalette: () => () => {},
        onToggleFloatingTerminal: () => () => {},
        onOpenQuickOpen: () => () => {},
        onToggleQuickCommandsMenu: () => () => {},
        onOpenNewWorkspace: () => () => {},
        onOpenTasks: () => () => {},
        onJumpToWorktreeIndex: () => () => {},
        onJumpToTabIndex: () => () => {},
        onActivateWorktree: () => () => {},
        onWorktreeHistoryNavigate: () => () => {},
        onCreateTerminal: (
          listener: (data: {
            requestId?: string
            worktreeId: string
            command?: string
            launchConfig?: SleepingAgentLaunchConfig
            launchAgent?: TuiAgent
            viewMode?: 'terminal' | 'chat'
            title?: string
            ptyId?: string
            activate?: boolean
            focus?: boolean
            presentation?: 'background' | 'focused'
            tabId?: string
            leafId?: string
            splitFromLeafId?: string
            splitDirection?: 'horizontal' | 'vertical'
            splitTelemetrySource?:
              | 'contextual_tour'
              | 'keyboard'
              | 'context_menu'
              | 'command'
              | 'unknown'
          }) => void
        ) => {
          createTerminalListenerRef.current = listener
          return () => {}
        },
        onRequestTerminalCreate: (
          listener: (data: {
            requestId: string
            worktreeId?: string
            afterTabId?: string
            targetGroupId?: string
            command?: string
            cwd?: string
            launchConfig?: SleepingAgentLaunchConfig
            launchAgent?: TuiAgent
            viewMode?: 'terminal' | 'chat'
            title?: string
            activate?: boolean
            presentation?: 'background' | 'focused'
          }) => void
        ) => {
          requestTerminalCreateListenerRef.current = listener
          return () => {}
        },
        onRequestTerminalTabMount: () => () => {},
        replyTerminalCreate,
        onSplitTerminal: () => () => {},
        onRenameTerminal: () => () => {},
        onFocusTerminal: (
          listener: (data: {
            tabId: string
            worktreeId: string
            leafId?: string | null
            ackPaneKeyOnSuccess?: string
            flashFocusedPane?: boolean
            scrollToBottomIfOutputSinceLastView?: boolean
          }) => void
        ) => {
          focusTerminalListenerRef.current = listener
          return () => {}
        },
        onFocusEditorTab: () => () => {},
        onCloseSessionTab: () => () => {},
        onSessionTabCloseRequest: () => () => {},
        respondSessionTabClose: () => {},
        onMoveSessionTab: () => () => {},
        onOpenFileFromMobile: () => () => {},
        onOpenDiffFromMobile: () => () => {},
        onCloseTerminal: () => () => {},
        onSleepWorktree: () => () => {},
        onResumeSleepingAgents: () => () => {},
        onNewBrowserTab: () => () => {},
        onNewMarkdownTab: () => () => {},
        onRequestTabCreate: () => () => {},
        replyTabCreate: () => {},
        onRequestTabClose: () => () => {},
        replyTabClose: vi.fn(),
        onRequestTabSetProfile: () => () => {},
        replyTabSetProfile: () => {},
        onNewTerminalTab: (listener: () => void) => {
          newTerminalTabListenerRef.current = listener
          return () => {}
        },
        onCloseActiveTab: () => () => {},
        onCloseFloatingItem: () => () => {},
        onSelectFloatingIndex: () => () => {},
        onSwitchTab: () => () => {},
        onSwitchTabAcrossAllTypes: () => () => {},
        onSwitchRecentTab: () => () => {},
        onSwitchTerminalTab: () => () => {},
        onToggleStatusBar: () => () => {},
        onFullscreenChanged: () => () => {},
        onTerminalZoom: () => () => {},
        getZoomLevel: () => 0,
        set: vi.fn()
      },
      settings: {
        onChanged: () => () => {}
      },
      updater: {
        getStatus: () => Promise.resolve({ state: 'idle' }),
        onStatus: () => () => {},
        onClearDismissal: () => () => {}
      },
      browser: {
        onGuestLoadFailed: () => () => {},
        onOpenLinkInOrcaTab: () => () => {},
        onNavigationUpdate: () => () => {},
        onActivateView: () => () => {},
        onPaneFocus: () => () => {}
      },
      rateLimits: {
        get: () => Promise.resolve({ limits: {}, lastUpdatedAt: Date.now() }),
        onUpdate: () => () => {}
      },
      runtime: {
        getTerminalFitOverrides: () => Promise.resolve([]),
        getTerminalDrivers: () => Promise.resolve([]),
        getBrowserDrivers: () => Promise.resolve([]),
        onTerminalFitOverrideChanged: () => () => {},
        onTerminalDriverChanged: () => () => {},
        onBrowserDriverChanged: () => () => {},
        onClientHostedBrowserRowsChanged: () => () => {},
        getClientHostedBrowserRows: async () => []
      },
      ssh: {
        listTargets: () => Promise.resolve([]),
        listPortForwards: () => Promise.resolve([]),
        listDetectedPorts: () => Promise.resolve([]),
        getState: () => Promise.resolve(null),
        onStateChanged: () => () => {},
        onCredentialRequest: () => () => {},
        onPortForwardsChanged: () => () => {},
        onDetectedPortsChanged: () => () => {},
        onCredentialResolved: () => () => {}
      },
      agentStatus: { onSet: () => () => {} }
    }
  }
}
