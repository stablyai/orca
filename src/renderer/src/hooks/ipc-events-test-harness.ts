import { vi } from 'vitest'
import type * as ReactModule from 'react'
import type { HarnessStoreState } from './ipc-events-harness-store-state'
import type { ClientHostedBrowserRowsEvent } from '../../../shared/client-hosted-browser-rows'

// Re-exported so a suite needs one import for the harness and the store surface it seeds.
export {
  createHarnessStoreState,
  type HarnessStoreState,
  type HarnessTab
} from './ipc-events-harness-store-state'

export type CreateTerminalRequest = {
  requestId?: string
  worktreeId: string
  command?: string
  title?: string
  ptyId?: string
  activate?: boolean
  presentation?: 'background' | 'focused'
  surfaceOwner?: boolean
  tabId?: string
  leafId?: string
  splitFromLeafId?: string
}

export type RequestTerminalCreateRequest = {
  requestId: string
  worktreeId?: string
  command?: string
  title?: string
  activate?: boolean
  presentation?: 'background' | 'focused'
  surfaceOwner?: boolean
}

/** Subscription no-ops for every listener useIpcEvents attaches beyond the ones under test. */
function createApiNamespaceStub(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return new Proxy(overrides, {
    get: (target, prop: string) => (prop in target ? target[prop] : () => () => {})
  })
}

export type IpcEventsHarness = {
  /** Call inside the test body: useIpcEvents runs its effects eagerly here. */
  useIpcEvents: () => void
  createTerminal: (request: CreateTerminalRequest) => void
  requestTerminalCreate: (request: RequestTerminalCreateRequest) => void
  focusEditorTab: (request: { tabId: string; worktreeId: string }) => void
  replyTerminalCreate: ReturnType<typeof vi.fn>
  /** Fire a main-process digit chord (zero-based index). */
  jumpToWorktreeIndex: (index: number) => void
  jumpToTabIndex: (index: number) => void
  navigationUpdate: (event: { browserPageId: string; url: string; title: string }) => void
  certificateFailureChanged: (event: { browserPageId: string; failure: unknown }) => void
  /** Fire a host-local push of the pages a paired client renders for a worktree. */
  clientHostedBrowserRowsChanged: (event: ClientHostedBrowserRowsEvent) => void
  /** Resolves the hydration round trip the hook starts, so buffered pushes drain. */
  settleClientHostedBrowserRowsSnapshot: () => Promise<void>
  /** Standard (non-palette) target of a workspace digit chord. */
  activateAndRevealWorkspace: ReturnType<typeof vi.fn>
}

export type IpcEventsHarnessOptions = {
  /** Sidebar order the workspace digit chord indexes into. */
  visibleWorktreeIds?: string[]
  visibleWorktreeTargets?: { id: string; executionHostId?: 'local' | `ssh:${string}` }[]
  /** Snapshot the client-hosted row hydration round trip resolves with. */
  clientHostedBrowserRowsSnapshot?: ClientHostedBrowserRowsEvent[]
  /** Rejects the hydration round trip instead of resolving it. */
  clientHostedBrowserRowsSnapshotError?: Error
}

/**
 * Loads useIpcEvents against a stubbed preload API so IPC behavior is asserted through the hook.
 */
export async function loadIpcEventsHarness(
  storeState: HarnessStoreState,
  options: IpcEventsHarnessOptions = {}
): Promise<IpcEventsHarness> {
  const replyTerminalCreate = vi.fn()
  const activateAndRevealWorkspace = vi.fn()
  let createTerminalListener: ((request: CreateTerminalRequest) => void) | null = null
  let requestTerminalCreateListener: ((request: RequestTerminalCreateRequest) => void) | null = null
  let focusEditorTabListener: ((request: { tabId: string; worktreeId: string }) => void) | null =
    null
  let navigationUpdateListener:
    | ((event: { browserPageId: string; url: string; title: string }) => void)
    | null = null
  let certificateFailureListener:
    | ((event: { browserPageId: string; failure: unknown }) => void)
    | null = null
  let clientHostedBrowserRowsListener: ((event: ClientHostedBrowserRowsEvent) => void) | null = null
  let resolveClientHostedBrowserRowsSnapshot: (() => void) | null = null
  const clientHostedBrowserRowsSnapshotGate = new Promise<void>((resolve) => {
    resolveClientHostedBrowserRowsSnapshot = resolve
  })
  const indexJumpListeners = new Map<string, (index: number) => void>()

  vi.resetModules()
  vi.unstubAllGlobals()

  vi.doMock('react', async () => {
    const actual = await vi.importActual<typeof ReactModule>('react')
    return { ...actual, useEffect: (effect: () => void | (() => void)) => void effect() }
  })
  vi.doMock('../store', () => ({
    useAppStore: { subscribe: vi.fn(() => () => {}), getState: () => storeState }
  }))
  vi.doMock('@/lib/ui-zoom', () => ({ applyUIZoom: vi.fn() }))
  vi.doMock('@/lib/worktree-activation', () => ({
    activateAndRevealWorktree: vi.fn(),
    activateAndRevealWorkspace,
    ensureWorktreeHasInitialTerminal: vi.fn()
  }))
  vi.doMock('@/components/sidebar/visible-worktrees', () => ({
    getVisibleWorktreeIds: () => options.visibleWorktreeIds ?? [],
    getVisibleWorktreeShortcutTargets: () =>
      options.visibleWorktreeTargets ?? (options.visibleWorktreeIds ?? []).map((id) => ({ id }))
  }))
  vi.doMock('@/lib/floating-workspace-terminal-actions', () => ({
    createFloatingWorkspaceTerminalTab: vi.fn(),
    isEmptyFloatingWorkspacePanelVisible: () => false,
    isFloatingWorkspacePanelFocused: () => false
  }))
  vi.doMock('@/runtime/web-runtime-session', () => ({
    activateWebRuntimeSessionTab: vi.fn(),
    closeWebRuntimeSessionTab: vi.fn(),
    createWebRuntimeSessionBrowserTab: vi.fn().mockResolvedValue(false),
    createWebRuntimeSessionTerminal: vi.fn().mockResolvedValue({ status: 'failed', message: '' }),
    isWebRuntimeSessionActive: vi.fn(() => false)
  }))
  vi.doMock('@/lib/focus-terminal-tab-surface', () => ({ focusTerminalTabSurface: vi.fn() }))
  vi.doMock('@/runtime/sync-runtime-graph', () => ({
    focusRuntimeTerminalSurface: vi.fn(() => false)
  }))
  vi.doMock('@/lib/activate-tab-and-focus-pane', () => ({ activateTabAndFocusPane: vi.fn() }))

  vi.stubGlobal('window', {
    dispatchEvent: vi.fn(),
    api: new Proxy(
      {
        ui: createApiNamespaceStub({
          getZoomLevel: () => 0,
          consumePendingOpenSettings: () => Promise.resolve(false),
          consumePendingSkillShare: () => Promise.resolve(null),
          set: vi.fn(),
          replyTabCreate: vi.fn(),
          replyTabClose: vi.fn(),
          replyTabSetProfile: vi.fn(),
          replyTerminalCreate,
          onCreateTerminal: (listener: (request: CreateTerminalRequest) => void) => {
            createTerminalListener = listener
            return () => {}
          },
          onRequestTerminalCreate: (listener: (request: RequestTerminalCreateRequest) => void) => {
            requestTerminalCreateListener = listener
            return () => {}
          },
          onFocusEditorTab: (
            listener: (request: { tabId: string; worktreeId: string }) => void
          ) => {
            focusEditorTabListener = listener
            return () => {}
          },
          onJumpToWorktreeIndex: (listener: (index: number) => void) => {
            indexJumpListeners.set('worktree', listener)
            return () => {}
          },
          onJumpToTabIndex: (listener: (index: number) => void) => {
            indexJumpListeners.set('tab', listener)
            return () => {}
          }
        }),
        rateLimits: {
          get: () => Promise.resolve({ limits: {}, lastUpdatedAt: 0 }),
          onUpdate: () => () => {}
        },
        runtime: {
          getTerminalFitOverrides: () => Promise.resolve([]),
          getTerminalDrivers: () => Promise.resolve([]),
          getBrowserDrivers: () => Promise.resolve([]),
          onTerminalFitOverrideChanged: () => () => {},
          onTerminalDriverChanged: () => () => {},
          onBrowserDriverChanged: () => () => {},
          onClientHostedBrowserRowsChanged: (
            listener: (event: ClientHostedBrowserRowsEvent) => void
          ) => {
            clientHostedBrowserRowsListener = listener
            return () => {}
          },
          getClientHostedBrowserRows: async () => {
            await clientHostedBrowserRowsSnapshotGate
            if (options.clientHostedBrowserRowsSnapshotError) {
              throw options.clientHostedBrowserRowsSnapshotError
            }
            return options.clientHostedBrowserRowsSnapshot ?? []
          }
        },
        ssh: {
          listTargets: () => Promise.resolve([]),
          listPortForwards: () => Promise.resolve([]),
          listDetectedPorts: () => Promise.resolve([]),
          listRemovedTargetLabels: () => Promise.resolve({}),
          getState: () => Promise.resolve(null),
          onStateChanged: () => () => {},
          onCredentialRequest: () => () => {},
          onCredentialResolved: () => () => {},
          onPortForwardsChanged: () => () => {},
          onDetectedPortsChanged: () => () => {}
        },
        updater: {
          getStatus: () => Promise.resolve({ state: 'idle' }),
          onStatus: () => () => {},
          onClearDismissal: () => () => {}
        },
        browser: createApiNamespaceStub({
          onNavigationUpdate: (
            listener: (event: { browserPageId: string; url: string; title: string }) => void
          ) => {
            navigationUpdateListener = listener
            return () => {}
          },
          onCertificateFailureChanged: (
            listener: (event: { browserPageId: string; failure: unknown }) => void
          ) => {
            certificateFailureListener = listener
            return () => {}
          }
        }),
        mobile: createApiNamespaceStub({
          consumePendingUnpairedDeviceAuthFailure: () => Promise.resolve(false)
        }),
        remoteWorkspace: createApiNamespaceStub({ clientId: () => Promise.resolve(null) })
      } as Record<string, unknown>,
      { get: (target, prop: string) => target[prop] ?? createApiNamespaceStub() }
    )
  })

  const { useIpcEvents } = await import('./useIpcEvents')
  return {
    useIpcEvents,
    createTerminal: (request) => {
      if (typeof createTerminalListener !== 'function') {
        throw new Error('Expected the create-terminal listener to be registered')
      }
      createTerminalListener(request)
    },
    requestTerminalCreate: (request) => {
      if (typeof requestTerminalCreateListener !== 'function') {
        throw new Error('Expected the request-terminal-create listener to be registered')
      }
      requestTerminalCreateListener(request)
    },
    focusEditorTab: (request) => {
      if (typeof focusEditorTabListener !== 'function') {
        throw new Error('Expected the focus-editor-tab listener to be registered')
      }
      focusEditorTabListener(request)
    },
    replyTerminalCreate,
    jumpToWorktreeIndex: (index) => fireIndexJump(indexJumpListeners, 'worktree', index),
    jumpToTabIndex: (index) => fireIndexJump(indexJumpListeners, 'tab', index),
    navigationUpdate: (event) => {
      if (typeof navigationUpdateListener !== 'function') {
        throw new Error('Expected the browser navigation listener to be registered')
      }
      navigationUpdateListener(event)
    },
    certificateFailureChanged: (event) => {
      if (typeof certificateFailureListener !== 'function') {
        throw new Error('Expected the browser certificate-failure listener to be registered')
      }
      certificateFailureListener(event)
    },
    clientHostedBrowserRowsChanged: (event) => {
      if (typeof clientHostedBrowserRowsListener !== 'function') {
        throw new Error('Expected the client-hosted browser rows listener to be registered')
      }
      clientHostedBrowserRowsListener(event)
    },
    settleClientHostedBrowserRowsSnapshot: async () => {
      resolveClientHostedBrowserRowsSnapshot?.()
      await clientHostedBrowserRowsSnapshotGate
      await Promise.resolve()
      await Promise.resolve()
    },
    activateAndRevealWorkspace
  }
}

function fireIndexJump(
  listeners: Map<string, (index: number) => void>,
  kind: string,
  index: number
): void {
  const listener = listeners.get(kind)
  if (!listener) {
    throw new Error(`Expected the ${kind}-index jump listener to be registered`)
  }
  listener(index)
}
