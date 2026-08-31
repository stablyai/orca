import type * as ReactModule from 'react'
import { vi } from 'vitest'
import type {
  AgentStatusClearIpcPayload,
  MigrationUnsupportedPtyEntry
} from '../../../shared/agent-status-types'
import type { AgentStatusSetData } from './ipc-events-agent-status-store-test-fixtures'

export function buildWindowApi(args: {
  onSet: (cb: (data: AgentStatusSetData) => void) => () => void
  onClear?: (cb: (data: AgentStatusClearIpcPayload) => void) => () => void
  onLegacyWorkerTerminalRecovery?: (
    cb: (data: { paneKey: string; resolution: 'adopted' | 'exited' }) => void
  ) => () => void
  getSnapshot?: () => Promise<AgentStatusSetData[]>
  getMigrationUnsupportedSnapshot?: () => Promise<MigrationUnsupportedPtyEntry[]>
  drop?: (paneKey: string) => void
  remoteWorkspace?: Record<string, unknown>
  runtime?: Record<string, unknown>
  ssh?: Record<string, unknown>
  ui?: Record<string, unknown>
}): Record<string, unknown> {
  return {
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
        onWorktreeHistoryNavigate: () => () => {},
        onActivateWorktree: () => () => {},
        onCreateTerminal: () => () => {},
        onRequestTerminalCreate: () => () => {},
        onRequestTerminalTabMount: () => () => {},
        replyTerminalCreate: () => {},
        onSplitTerminal: () => () => {},
        onRenameTerminal: () => () => {},
        onFocusTerminal: () => () => {},
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
        replyTabClose: () => {},
        onRequestTabSetProfile: () => () => {},
        replyTabSetProfile: () => {},
        onNewTerminalTab: () => () => {},
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
        set: vi.fn(),
        ...args.ui
      },
      settings: { onChanged: () => () => {} },
      updater: {
        getStatus: () => Promise.resolve({ state: 'idle' }),
        onStatus: () => () => {},
        onClearDismissal: () => () => {}
      },
      browser: {
        onGuestLoadFailed: () => () => {},
        onPaneFocus: () => () => {},
        onOpenLinkInOrcaTab: () => () => {},
        onNavigationUpdate: () => () => {},
        onActivateView: () => () => {}
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
        getClientHostedBrowserRows: async () => [],
        ...args.runtime
      },
      ssh: {
        listTargets: () => Promise.resolve([]),
        listRemovedTargetLabels: () => Promise.resolve({}),
        listPortForwards: () => Promise.resolve([]),
        listDetectedPorts: () => Promise.resolve([]),
        getState: () => Promise.resolve(null),
        onStateChanged: () => () => {},
        onCredentialRequest: () => () => {},
        onCredentialResolved: () => () => {},
        onPortForwardsChanged: () => () => {},
        onDetectedPortsChanged: () => () => {},
        ...args.ssh
      },
      agentStatus: {
        onSet: args.onSet,
        onClear: args.onClear ?? vi.fn(() => () => {}),
        onLegacyWorkerTerminalRecovery:
          args.onLegacyWorkerTerminalRecovery ?? vi.fn(() => () => {}),
        getSnapshot: args.getSnapshot ?? vi.fn(() => Promise.resolve([])),
        ...(args.getMigrationUnsupportedSnapshot
          ? { getMigrationUnsupportedSnapshot: args.getMigrationUnsupportedSnapshot }
          : {}),
        drop: args.drop ?? vi.fn()
      },
      remoteWorkspace: args.remoteWorkspace
    }
  }
}

export function stubReactSyncEffect(): void {
  vi.doMock('react', async () => {
    const actual = await vi.importActual<typeof ReactModule>('react')
    return {
      ...actual,
      useEffect: (effect: () => void | (() => void)) => {
        effect()
      }
    }
  })
}

export function stubAuxiliaryModules(): void {
  vi.doMock('@/lib/ui-zoom', () => ({ applyUIZoom: vi.fn() }))
  vi.doMock('@/lib/worktree-activation', () => ({
    activateAndRevealWorktree: vi.fn(),
    ensureWorktreeHasInitialTerminal: vi.fn()
  }))
  vi.doMock('@/components/sidebar/visible-worktrees', () => ({
    getVisibleWorktreeIds: () => []
  }))
  vi.doMock('@/lib/editor-font-zoom', () => ({
    nextEditorFontZoomLevel: vi.fn(() => 0),
    computeEditorFontSize: vi.fn(() => 13)
  }))
  vi.doMock('@/components/settings/SettingsConstants', () => ({
    zoomLevelToPercent: vi.fn(() => 100),
    ZOOM_MIN: -3,
    ZOOM_MAX: 3
  }))
  vi.doMock('@/lib/zoom-events', () => ({ dispatchZoomLevelChanged: vi.fn() }))
}
