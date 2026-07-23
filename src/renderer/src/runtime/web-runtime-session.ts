/* eslint-disable max-lines */
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type {
  BrowserTabCreateResult,
  RuntimeMobileSessionCreateTerminalResult,
  RuntimeMobileSessionTabCloseResult,
  RuntimeMobileSessionTabMove,
  RuntimeMobileSessionTabMoveResult,
  RuntimeMobileSessionTabsResult,
  RuntimeSessionTabCloseReason,
  RuntimeTerminalClose,
  RuntimeTerminalSplit
} from '../../../shared/runtime-types'
import type { TerminalPaneSplitSource } from '../../../shared/feature-education-telemetry'
import type { StartupCommandDelivery } from '../../../shared/codex-startup-delivery'
import type { SleepingAgentLaunchConfig } from '../../../shared/agent-session-resume'
import type { AgentProviderSessionMetadata } from '../../../shared/agent-session-resume'
import type {
  AgentLaunchPreferences,
  AgentPromptDelivery,
  RuntimeCreateAgentSessionResult,
  RuntimeEnsureAgentSessionResult
} from '../../../shared/agent-session-host-authority'
import type { TerminalPaneLayoutNode, TuiAgent } from '../../../shared/types'
import type { AppState } from '../store/types'
import { getRuntimeEnvironmentIdForWorktree } from '../lib/worktree-runtime-owner'
import { useAppStore } from '../store'
import { unwrapRuntimeRpcResult } from './runtime-rpc-client'
import {
  createAgentSessionCreateOperation,
  withAgentSessionCreateOperationId
} from './agent-session-create-operation'
import { parseRemoteRuntimePtyId } from './runtime-terminal-stream'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'
import { recordWebSessionFocusIntent } from './web-session-focus-intent'
import { clearWebSessionCloseIntent, recordWebSessionCloseIntent } from './web-session-close-intent'
import {
  clearWebSessionReorderIntent,
  recordWebSessionReorderIntent
} from './web-session-reorder-intent'
import type { WebSessionIntentOwner } from './web-session-intent-owner'
import {
  isWebTerminalSurfaceTabId,
  toHostSessionTabId,
  toWebTerminalSurfaceTabId
} from './web-terminal-surface-id'
import { deliverLaunchPromptToAgentTab } from '../lib/agent-launch-prompt-delivery'
import {
  listRemoteRuntimeSessionTabsAfterCurrentInFlight,
  listRemoteRuntimeSessionTabsDeduped
} from './remote-runtime-session-tabs-inflight'
import { runRemoteAgentSessionLaunch } from './remote-agent-session-launch'
import { translate } from '../i18n/i18n'
import { getRuntimeEnvironmentRevision } from './runtime-environment-revision'

export {
  HOST_TERMINAL_SURFACE_SEPARATOR,
  isWebTerminalSurfaceTabId,
  toHostSessionTabId,
  toWebTerminalSurfaceTabId,
  WEB_TERMINAL_SURFACE_TAB_PREFIX
} from './web-terminal-surface-id'

export function isWebRuntimeSessionActive(
  activeRuntimeEnvironmentId: string | null | undefined
): boolean {
  // Why: headless serve sessions are owned by the remote runtime, whether the client is web or desktop Electron.
  return Boolean(activeRuntimeEnvironmentId?.trim())
}

export type WebRuntimeTerminalCreateOutcome =
  | { status: 'created' }
  | { status: 'failed'; message: string }

const pendingWebRuntimeSplitMirrorTelemetry = new Map<string, Set<string>>()
const WEB_RUNTIME_SPLIT_MIRROR_SUPPRESSION_TTL_MS = 30_000
let pendingWebRuntimeSplitMirrorTelemetryId = 0
const pendingRuntimeWorktreeRecoveryRefreshes = new Map<string, symbol>()
const RUNTIME_WORKTREE_RECOVERY_REFRESH_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000] as const

function captureRuntimeEnvironmentCall(
  environmentId: string,
  expectedEnvironmentPairingRevision = getRuntimeEnvironmentRevision(environmentId)
): (args: {
  method: string
  params?: unknown
  timeoutMs?: number
}) => Promise<RuntimeRpcResponse<unknown>> {
  return (args) =>
    window.api.runtimeEnvironments.call({
      selector: environmentId,
      ...args,
      expectedEnvironmentPairingRevision
    })
}

function captureWebSessionIntentOwner(environmentId: string): WebSessionIntentOwner {
  return {
    environmentId,
    pairingRevision: getRuntimeEnvironmentRevision(environmentId)
  }
}

function matchesWebSessionIntentOwner(owner: WebSessionIntentOwner): boolean {
  return getRuntimeEnvironmentRevision(owner.environmentId) === owner.pairingRevision
}

type CreateWebRuntimeSessionTerminalArgs = {
  worktreeId: string
  environmentId?: string | null
  afterTabId?: string
  targetGroupId?: string
  command?: string
  cwd?: string
  env?: Record<string, string>
  envToDelete?: string[]
  startupCommandDelivery?: StartupCommandDelivery
  launchConfig?: SleepingAgentLaunchConfig
  launchToken?: string
  agent?: TuiAgent
  launchAgent?: TuiAgent
  agentSessionKind?: 'fresh' | 'resume'
  prompt?: string
  promptDelivery?: AgentPromptDelivery
  /** Explicit CLI override; omission leaves the remote host's defaults authoritative. */
  agentArgs?: string | null
  launchPreferences?: AgentLaunchPreferences
  providerSession?: AgentProviderSessionMetadata
  viewMode?: 'terminal' | 'chat'
  activate?: boolean
  selectWorktree?: boolean
}

type CreatedWebRuntimeSessionTerminal = {
  outcome: WebRuntimeTerminalCreateOutcome
  hostTabId?: string
}

export async function createWebRuntimeSessionTerminal(
  args: CreateWebRuntimeSessionTerminalArgs
): Promise<WebRuntimeTerminalCreateOutcome> {
  return (await createWebRuntimeSessionTerminalResult(args)).outcome
}

export async function createWebRuntimeAgentSessionTerminal(
  args: CreateWebRuntimeSessionTerminalArgs & {
    agent: TuiAgent
    promptAfterReady: string
    submitPrompt: boolean
    forcePromptPaste: boolean
  }
): Promise<{
  outcome: WebRuntimeTerminalCreateOutcome
  promptDelivered: boolean
}> {
  const created = await createWebRuntimeSessionTerminalResult(args)
  if (created.outcome.status === 'failed' || !created.hostTabId) {
    return { outcome: created.outcome, promptDelivered: false }
  }

  const promptDelivered = await deliverLaunchPromptToAgentTab({
    tabId: toWebTerminalSurfaceTabId(created.hostTabId),
    content: args.promptAfterReady,
    agent: args.agent,
    submit: args.submitPrompt,
    forcePaste: args.forcePromptPaste
  })
  return { outcome: created.outcome, promptDelivered }
}

async function createWebRuntimeSessionTerminalResult(
  args: CreateWebRuntimeSessionTerminalArgs
): Promise<CreatedWebRuntimeSessionTerminal> {
  const environmentId =
    args.environmentId?.trim() ??
    useAppStore.getState().settings?.activeRuntimeEnvironmentId?.trim() ??
    null
  if (!environmentId || !isWebRuntimeSessionActive(environmentId)) {
    return {
      outcome: {
        status: 'failed',
        message: translate(
          'auto.runtime.webRuntimeSession.remoteHostDisconnected',
          'The workspace is not connected to a remote Orca host.'
        )
      }
    }
  }
  const intentOwner = captureWebSessionIntentOwner(environmentId)
  const callEnvironment = captureRuntimeEnvironmentCall(environmentId, intentOwner.pairingRevision)

  if (args.selectWorktree !== false) {
    selectWebRuntimeSessionWorktree(args.worktreeId)
  }
  let hostCreated = false
  let createdTabId: string | undefined
  try {
    const agent = args.launchAgent ?? args.agent
    const agentArgsOverride =
      args.agentArgs !== undefined ? args.agentArgs : args.launchConfig?.agentArgs
    if (agent) {
      let legacyAlreadyPlacedInGroup = false
      // Why: structured creation cannot yet express afterTabId; keep the exact legacy placement contract until it can.
      const hostAuthority = args.afterTabId
        ? undefined
        : args.agentSessionKind === 'resume'
          ? args.providerSession
            ? async () =>
                unwrapRuntimeRpcResult(
                  (await callEnvironment({
                    method: 'terminal.ensureAgentSession',
                    params: {
                      kind: 'explicit',
                      worktree: toRuntimeWorktreeSelector(args.worktreeId),
                      agent,
                      providerSession: args.providerSession!,
                      ...(agentArgsOverride !== undefined ? { agentArgs: agentArgsOverride } : {}),
                      ...(args.launchPreferences
                        ? { launchPreferences: args.launchPreferences }
                        : {}),
                      presentation: args.activate === false ? 'background' : 'focused'
                    },
                    timeoutMs: 15_000
                  })) as RuntimeRpcResponse<RuntimeEnsureAgentSessionResult>
                )
            : undefined
          : async () =>
              await createAgentSessionCreateOperation().run(async (clientOperationId) =>
                unwrapRuntimeRpcResult(
                  (await callEnvironment({
                    method: 'terminal.createAgentSession',
                    params: withAgentSessionCreateOperationId(
                      {
                        worktree: toRuntimeWorktreeSelector(args.worktreeId),
                        agent,
                        ...(args.prompt ? { prompt: args.prompt } : {}),
                        ...(args.promptDelivery ? { promptDelivery: args.promptDelivery } : {}),
                        ...(agentArgsOverride !== undefined
                          ? { agentArgs: agentArgsOverride }
                          : {}),
                        ...(args.launchPreferences
                          ? { launchPreferences: args.launchPreferences }
                          : {}),
                        ...(args.cwd ? { startupCwd: args.cwd } : {}),
                        ...(args.viewMode ? { viewMode: args.viewMode } : {}),
                        presentation: args.activate === false ? 'background' : 'focused'
                      },
                      clientOperationId
                    ),
                    timeoutMs: 15_000
                  })) as RuntimeRpcResponse<RuntimeCreateAgentSessionResult>
                )
              )
      const created = await runRemoteAgentSessionLaunch<{ terminal: { tabId?: string } }>({
        environmentId,
        ...(hostAuthority ? { hostAuthority } : {}),
        legacy: async () => {
          const response = await callEnvironment({
            method: 'session.tabs.createTerminal',
            params: {
              worktree: toRuntimeWorktreeSelector(args.worktreeId),
              afterTabId: args.afterTabId ? toHostSessionTabId(args.afterTabId) : undefined,
              targetGroupId: args.targetGroupId,
              command: args.command,
              cwd: args.cwd,
              ...(args.env ? { env: args.env } : {}),
              ...(args.envToDelete ? { envToDelete: args.envToDelete } : {}),
              startupCommandDelivery: args.startupCommandDelivery,
              ...(args.launchConfig ? { launchConfig: args.launchConfig } : {}),
              ...(args.launchToken ? { launchToken: args.launchToken } : {}),
              ...(args.agent ? { agent: args.agent } : {}),
              ...(args.launchAgent ? { launchAgent: args.launchAgent } : {}),
              ...(args.viewMode ? { viewMode: args.viewMode } : {}),
              // Why: old hosts understand activate:false; new hosts use select/navigation for caller-local focus.
              activate: false,
              select: args.activate !== false,
              navigation: 'caller'
            },
            timeoutMs: 15_000
          })
          const legacyCreated = unwrapRuntimeRpcResult(
            response as RuntimeRpcResponse<RuntimeMobileSessionCreateTerminalResult>
          )
          legacyAlreadyPlacedInGroup = true
          return { terminal: { tabId: legacyCreated.tab.id } }
        }
      })
      hostCreated = true
      createdTabId = created.terminal.tabId
      if (args.targetGroupId && createdTabId && !legacyAlreadyPlacedInGroup) {
        await callEnvironment({
          method: 'session.tabs.move',
          params: {
            worktree: toRuntimeWorktreeSelector(args.worktreeId),
            tabId: createdTabId,
            targetGroupId: args.targetGroupId,
            kind: 'move-to-group'
          },
          timeoutMs: 15_000
        })
      }
    } else {
      const response = await callEnvironment({
        method: 'session.tabs.createTerminal',
        params: {
          worktree: toRuntimeWorktreeSelector(args.worktreeId),
          afterTabId: args.afterTabId ? toHostSessionTabId(args.afterTabId) : undefined,
          targetGroupId: args.targetGroupId,
          command: args.command,
          cwd: args.cwd,
          ...(args.env ? { env: args.env } : {}),
          ...(args.envToDelete ? { envToDelete: args.envToDelete } : {}),
          startupCommandDelivery: args.startupCommandDelivery,
          ...(args.launchConfig ? { launchConfig: args.launchConfig } : {}),
          ...(args.launchToken ? { launchToken: args.launchToken } : {}),
          ...(args.viewMode ? { viewMode: args.viewMode } : {}),
          // Why: old hosts understand activate:false; new hosts use select/navigation for caller-local focus.
          activate: false,
          select: args.activate !== false,
          navigation: 'caller'
        },
        timeoutMs: 15_000
      })
      const created = unwrapRuntimeRpcResult(
        response as RuntimeRpcResponse<RuntimeMobileSessionCreateTerminalResult>
      )
      hostCreated = true
      createdTabId = created.tab.id
    }
    if (args.activate !== false && createdTabId && matchesWebSessionIntentOwner(intentOwner)) {
      // Why: record focus intent so the reconcile follows the snapshot's active
      // tab to THIS new terminal, instead of sticky-keeping the prior tab.
      recordWebSessionFocusIntent(intentOwner, args.worktreeId, createdTabId)
    }
    await refreshWebRuntimeSessionTabsSnapshot(environmentId, args.worktreeId, {
      expectedEnvironmentPairingRevision: intentOwner.pairingRevision
    })
    return {
      outcome: { status: 'created' },
      ...(createdTabId ? { hostTabId: createdTabId } : {})
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(
      hostCreated
        ? '[web-runtime-session] terminal created but reconciliation failed:'
        : '[web-runtime-session] failed to create terminal:',
      message
    )
    // Why: once the host accepted creation, reporting failure invites the user
    // to retry with a new operation ID and can duplicate a fresh agent.
    return {
      outcome: hostCreated ? { status: 'created' } : { status: 'failed', message },
      ...(createdTabId ? { hostTabId: createdTabId } : {})
    }
  }
}

export async function createWebRuntimeSessionBrowserTab(args: {
  worktreeId: string
  environmentId?: string | null
  url?: string
  profileId?: string | null
  targetGroupId?: string
  selectWorktree?: boolean
}): Promise<boolean> {
  const environmentId =
    args.environmentId?.trim() ??
    useAppStore.getState().settings?.activeRuntimeEnvironmentId?.trim() ??
    null
  if (!environmentId || !isWebRuntimeSessionActive(environmentId)) {
    return false
  }
  const intentOwner = captureWebSessionIntentOwner(environmentId)
  const callEnvironment = captureRuntimeEnvironmentCall(environmentId, intentOwner.pairingRevision)

  const shouldSelectWorktree = args.selectWorktree !== false
  const stagedFromWorktreeId = useAppStore.getState().activeWorktreeId
  if (shouldSelectWorktree) {
    selectWebRuntimeSessionWorktree(args.worktreeId)
  }
  try {
    const response = await callEnvironment({
      method: 'browser.tabCreate',
      params: {
        worktree: toRuntimeWorktreeSelector(args.worktreeId),
        url: args.url,
        profileId: args.profileId ?? undefined,
        // Why: user clicked "New Browser Tab", so mark it active in the snapshot, else the reconcile snaps back to a terminal.
        activate: true,
        // Why: place the new browser in the clicked split group so the host snapshot is authoritative for it (no left-snap).
        ...(args.targetGroupId ? { targetGroupId: args.targetGroupId } : {}),
        // Why: web clients need the local tab now; waiting for host webview registration makes the workspace appear to close.
        waitForRegistration: false
      },
      timeoutMs: 15_000
    })
    const created = unwrapRuntimeRpcResult(response as RuntimeRpcResponse<BrowserTabCreateResult>)
    // Why: record focus intent (tab id === browserPageId on a headless host) so the reconcile follows to the new browser tab.
    if (matchesWebSessionIntentOwner(intentOwner)) {
      recordWebSessionFocusIntent(intentOwner, args.worktreeId, created.browserPageId)
    }
    stageWebRuntimeBrowserTab({
      environmentId,
      worktreeId: args.worktreeId,
      remotePageId: created.browserPageId,
      url: args.url,
      targetGroupId: args.targetGroupId,
      restoreFocus:
        shouldSelectWorktree &&
        (stagedFromWorktreeId === args.worktreeId ||
          useAppStore.getState().activeWorktreeId === args.worktreeId)
    })
    void refreshWebRuntimeSessionTabsSnapshot(environmentId, args.worktreeId, {
      expectedEnvironmentPairingRevision: intentOwner.pairingRevision
    })
    return true
  } catch (error) {
    console.warn(
      '[web-runtime-session] failed to create browser tab:',
      error instanceof Error ? error.message : String(error)
    )
    return false
  }
}

function stageWebRuntimeBrowserTab(args: {
  environmentId: string
  worktreeId: string
  remotePageId: string
  url?: string
  targetGroupId?: string
  restoreFocus?: boolean
}): void {
  const remotePageId = args.remotePageId.trim()
  if (!remotePageId) {
    return
  }

  const existing = findLocalBrowserPageForRemotePage(
    useAppStore.getState(),
    args.environmentId,
    remotePageId
  )
  if (args.restoreFocus !== false) {
    selectWebRuntimeSessionWorktree(args.worktreeId)
  }

  if (existing) {
    if (args.restoreFocus !== false) {
      useAppStore
        .getState()
        .focusBrowserTabInWorktree(args.worktreeId, existing.pageId, { surfacePane: true })
    }
    return
  }

  const url = args.url?.trim() || 'about:blank'
  // Why: the snapshot can arrive after React renders a fallback; stage the handle now so the worktree stays selected.
  const browserTab = useAppStore.getState().createBrowserTab(args.worktreeId, url, {
    title: url === 'about:blank' ? 'New Browser Tab' : url,
    focusAddressBar: true,
    browserRuntimeEnvironmentId: args.environmentId,
    targetGroupId: args.targetGroupId
  })
  const pageId = browserTab.activePageId ?? browserTab.pageIds?.[0] ?? null
  if (!pageId) {
    return
  }
  useAppStore.getState().setRemoteBrowserPageHandle(pageId, {
    environmentId: args.environmentId,
    remotePageId
  })
}

function selectWebRuntimeSessionWorktree(worktreeId: string): void {
  useAppStore.getState().setActiveWorktree(worktreeId)
}

function findLocalBrowserPageForRemotePage(
  state: AppState,
  environmentId: string,
  remotePageId: string
): { pageId: string } | null {
  for (const pages of Object.values(state.browserPagesByWorkspace)) {
    for (const page of pages) {
      const handle = state.remoteBrowserPageHandlesByPageId[page.id]
      if (handle?.environmentId === environmentId && handle.remotePageId === remotePageId) {
        return { pageId: page.id }
      }
    }
  }
  return null
}

export async function refreshWebRuntimeSessionTabsSnapshot(
  environmentId: string,
  worktreeId: string,
  options: {
    expectedEnvironmentPairingRevision?: number
    acceptCurrentSnapshot?: boolean
    confirmAgentSessionHandoff?: {
      provisionalTabId: string
      hostTabId: string
      hostTerminalHandle: string
    }
  } = {}
): Promise<void> {
  const expectedEnvironmentPairingRevision =
    options.expectedEnvironmentPairingRevision ?? getRuntimeEnvironmentRevision(environmentId)
  const callEnvironment = captureRuntimeEnvironmentCall(
    environmentId,
    expectedEnvironmentPairingRevision
  )
  try {
    if (options.acceptCurrentSnapshot) {
      const { acceptReplayedWebSessionTabsSnapshot } = await import('./web-session-tabs-sync')
      // Why: the host snapshot may have arrived before structured create returned;
      // re-accept its current version after the exact provisional handoff is known.
      acceptReplayedWebSessionTabsSnapshot(environmentId, worktreeId)
    }
    const listSessionTabs = options.confirmAgentSessionHandoff
      ? listRemoteRuntimeSessionTabsAfterCurrentInFlight
      : listRemoteRuntimeSessionTabsDeduped
    const snapshot = await listSessionTabs({
      environmentId,
      worktreeId,
      load: async () => {
        const response = await callEnvironment({
          method: 'session.tabs.list',
          params: {
            worktree: toRuntimeWorktreeSelector(worktreeId)
          },
          timeoutMs: 15_000
        })
        return unwrapRuntimeRpcResult(
          response as RuntimeRpcResponse<RuntimeMobileSessionTabsResult>
        )
      }
    })
    if (options.confirmAgentSessionHandoff) {
      const { confirmWebAgentSessionHandoffAfterCreate } =
        await import('./web-agent-session-handoff')
      // Why: this list completed after structured creation, so absence now proves the exact host tab already retired.
      confirmWebAgentSessionHandoffAfterCreate({
        environmentId,
        worktreeId,
        ...options.confirmAgentSessionHandoff
      })
    }
    const { applyFreshWebSessionTabsSnapshot, applyWebSessionTabsStorePatch } =
      await import('./web-session-tabs-sync')
    if (getRuntimeEnvironmentRevision(environmentId) !== expectedEnvironmentPairingRevision) {
      return
    }
    applyWebSessionTabsStorePatch((state) => {
      // Why: eager refreshes can resolve after the user switched worktrees; update tabs without stealing focus.
      const patch = applyFreshWebSessionTabsSnapshot(state, snapshot, environmentId)
      return patch === state ? state : patch
    })
  } catch (error) {
    // Why: host creation already succeeded; the long-lived session.tabs subscription catches up if this eager refresh fails.
    console.warn(
      '[web-runtime-session] failed to refresh session-tabs snapshot:',
      error instanceof Error ? error.message : String(error)
    )
  }
}

function scheduleRuntimeWorktreeRecoveryRefresh(
  environmentId: string,
  worktreeId: string,
  expectedEnvironmentPairingRevision = getRuntimeEnvironmentRevision(environmentId)
): void {
  const initialState = useAppStore.getState()
  if (!('tabsByWorktree' in initialState)) {
    return
  }
  if ((initialState.tabsByWorktree[worktreeId] ?? []).length > 0) {
    return
  }
  const key = `${environmentId}\0${expectedEnvironmentPairingRevision ?? ''}\0${worktreeId}`
  const token = Symbol(key)
  pendingRuntimeWorktreeRecoveryRefreshes.set(key, token)
  void (async () => {
    try {
      for (const delayMs of RUNTIME_WORKTREE_RECOVERY_REFRESH_DELAYS_MS) {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
        if (pendingRuntimeWorktreeRecoveryRefreshes.get(key) !== token) {
          return
        }
        if (getRuntimeEnvironmentRevision(environmentId) !== expectedEnvironmentPairingRevision) {
          return
        }
        await refreshWebRuntimeSessionTabsSnapshot(environmentId, worktreeId, {
          expectedEnvironmentPairingRevision
        })
        if ((useAppStore.getState().tabsByWorktree[worktreeId] ?? []).length > 0) {
          return
        }
      }
    } finally {
      if (pendingRuntimeWorktreeRecoveryRefreshes.get(key) === token) {
        pendingRuntimeWorktreeRecoveryRefreshes.delete(key)
      }
    }
  })()
}

export async function activateWebRuntimeSessionWorktree(args: {
  worktreeId: string
  environmentId?: string | null
}): Promise<boolean> {
  const environmentId =
    args.environmentId?.trim() ??
    useAppStore.getState().settings?.activeRuntimeEnvironmentId?.trim() ??
    null
  if (!environmentId || !isWebRuntimeSessionActive(environmentId)) {
    return false
  }
  const intentOwner = captureWebSessionIntentOwner(environmentId)
  const callEnvironment = captureRuntimeEnvironmentCall(environmentId, intentOwner.pairingRevision)

  try {
    const response = await callEnvironment({
      method: 'worktree.activate',
      params: {
        worktree: toRuntimeWorktreeSelector(args.worktreeId),
        // Why: notifyClients:false keeps navigation local when this client reaches an older host.
        notifyClients: false,
        navigation: 'caller'
      },
      timeoutMs: 15_000
    })
    unwrapRuntimeRpcResult(response as RuntimeRpcResponse<unknown>)
    // Why: a restarted HUB can recover its SSH pane after this client's subscription replayed an empty startup snapshot.
    await refreshWebRuntimeSessionTabsSnapshot(environmentId, args.worktreeId, {
      expectedEnvironmentPairingRevision: intentOwner.pairingRevision,
      acceptCurrentSnapshot: true
    })
    // Why: HUB reachability can precede its nested SSH relay; bounded owner-scoped re-lists converge without asking the paired client to connect SSH itself.
    scheduleRuntimeWorktreeRecoveryRefresh(
      environmentId,
      args.worktreeId,
      intentOwner.pairingRevision
    )
    return true
  } catch (error) {
    console.warn(
      '[web-runtime-session] failed to activate worktree:',
      error instanceof Error ? error.message : String(error)
    )
    return false
  }
}

export async function activateWebRuntimeSessionTab(args: {
  worktreeId: string
  tabId: string
  environmentId?: string | null
}): Promise<boolean> {
  return callWebRuntimeSessionTabMethod('session.tabs.activate', args)
}

export async function closeWebRuntimeSessionTab(args: {
  worktreeId: string
  tabId: string
  environmentId?: string | null
  reason: RuntimeSessionTabCloseReason
  publicationEpoch?: string | null
  terminalHandle?: string | null
}): Promise<boolean> {
  return callWebRuntimeSessionTabMethod('session.tabs.close', args)
}

export async function moveWebRuntimeSessionTab(
  args: RuntimeMobileSessionTabMove & {
    worktreeId: string
    environmentId?: string | null
  }
): Promise<boolean> {
  const environmentId =
    args.environmentId?.trim() ??
    useAppStore.getState().settings?.activeRuntimeEnvironmentId?.trim() ??
    null
  if (!environmentId || !isWebRuntimeSessionActive(environmentId)) {
    return false
  }
  const intentOwner = captureWebSessionIntentOwner(environmentId)
  const callEnvironment = captureRuntimeEnvironmentCall(environmentId, intentOwner.pairingRevision)

  if (args.kind === 'reorder') {
    // Why: record local order synchronously before async host resolution, so a pre-move snapshot can't snap the tab back.
    recordWebSessionReorderIntent(
      intentOwner,
      args.worktreeId,
      args.targetGroupId,
      args.tabOrder,
      Date.now()
    )
  }

  try {
    const { resolveHostSessionTabIdForWebSessionTab } = await import('./web-session-tabs-sync')
    const state = useAppStore.getState()
    const resolveHostBackedTabId = (tabId: string): string | null =>
      resolveHostSessionTabIdForWebSessionTab(state, {
        environmentId,
        worktreeId: args.worktreeId,
        tabId
      }) ?? (isWebTerminalSurfaceTabId(tabId) ? toHostSessionTabId(tabId) : null)
    const toHostTabId = (tabId: string): string => resolveHostBackedTabId(tabId) ?? tabId
    const movedHostTabId =
      args.kind === 'reorder' ? resolveHostBackedTabId(args.tabId) : toHostTabId(args.tabId)
    if (!movedHostTabId) {
      clearWebSessionReorderIntent(intentOwner, args.worktreeId, args.targetGroupId)
      return false
    }
    const reorderedHostTabOrder =
      args.kind === 'reorder'
        ? args.tabOrder
            .map(resolveHostBackedTabId)
            .filter((tabId): tabId is string => Boolean(tabId))
        : null
    if (reorderedHostTabOrder && !reorderedHostTabOrder.includes(movedHostTabId)) {
      clearWebSessionReorderIntent(intentOwner, args.worktreeId, args.targetGroupId)
      return false
    }
    const targetHostIndex =
      args.kind === 'move-to-group' && typeof args.index === 'number'
        ? (state.groupsByWorktree?.[args.worktreeId]
            ?.find((group) => group.id === args.targetGroupId)
            ?.tabOrder.slice(0, args.index)
            .map(resolveHostBackedTabId)
            .filter((tabId): tabId is string => Boolean(tabId)).length ?? args.index)
        : args.kind === 'move-to-group'
          ? args.index
          : undefined
    const base = {
      worktree: toRuntimeWorktreeSelector(args.worktreeId),
      tabId: movedHostTabId,
      targetGroupId: args.targetGroupId
    }
    const move =
      args.kind === 'reorder'
        ? {
            ...base,
            kind: 'reorder' as const,
            // Why: the host reorder API only accepts host tab ids, so local-only tabs must be omitted from the mirrored order.
            tabOrder: reorderedHostTabOrder
          }
        : args.kind === 'split'
          ? {
              ...base,
              kind: 'split' as const,
              splitDirection: args.splitDirection
            }
          : {
              ...base,
              kind: 'move-to-group' as const,
              // Why: web groups can contain local-only tabs, so host insertion indexes count only the filtered host-backed order.
              index: targetHostIndex
            }
    const response = await callEnvironment({
      method: 'session.tabs.move',
      params: move,
      timeoutMs: 15_000
    })
    unwrapRuntimeRpcResult(response as RuntimeRpcResponse<RuntimeMobileSessionTabMoveResult>)
    return true
  } catch (error) {
    if (args.kind === 'reorder') {
      clearWebSessionReorderIntent(intentOwner, args.worktreeId, args.targetGroupId)
    }
    console.warn(
      '[web-runtime-session] failed to move tab:',
      error instanceof Error ? error.message : String(error)
    )
    return false
  }
}

async function callWebRuntimeSessionTabMethod(
  method: 'session.tabs.activate' | 'session.tabs.close',
  args: {
    worktreeId: string
    tabId: string
    environmentId?: string | null
    reason?: RuntimeSessionTabCloseReason
    publicationEpoch?: string | null
    terminalHandle?: string | null
  }
): Promise<boolean> {
  const environmentId =
    args.environmentId?.trim() ??
    useAppStore.getState().settings?.activeRuntimeEnvironmentId?.trim() ??
    null
  if (!environmentId || !isWebRuntimeSessionActive(environmentId)) {
    return false
  }
  const intentOwner = captureWebSessionIntentOwner(environmentId)
  const callEnvironment = captureRuntimeEnvironmentCall(environmentId, intentOwner.pairingRevision)
  const closeIntentTabIds = new Set<string>()

  const isClose = method === 'session.tabs.close'
  const isLifecycleClose = isClose && args.reason !== 'user'
  if (isLifecycleClose && (!args.publicationEpoch || !args.terminalHandle)) {
    // Why: missing host-generation or terminal-incarnation evidence means keep;
    // a tab id alone can be stale or reused after reconnect.
    const { acceptReplayedWebSessionTabsSnapshot } = await import('./web-session-tabs-sync')
    acceptReplayedWebSessionTabsSnapshot(environmentId, args.worktreeId)
    await refreshWebRuntimeSessionTabsSnapshot(environmentId, args.worktreeId)
    console.warn('[web-runtime-session] suppressed lifecycle close without incarnation evidence', {
      closeReason: args.reason
    })
    return false
  }

  const immediateHostTabId = toHostSessionTabId(args.tabId)
  if (isClose) {
    // Why: record before async id resolution so a stale snapshot cannot flash the closed tab back.
    closeIntentTabIds.add(immediateHostTabId)
    recordWebSessionCloseIntent(intentOwner, args.worktreeId, immediateHostTabId, Date.now())
  }

  try {
    const { resolveHostSessionTabIdForWebSessionTab } = await import('./web-session-tabs-sync')
    const state = useAppStore.getState()
    const hostTabId =
      resolveHostSessionTabIdForWebSessionTab(state, {
        environmentId,
        worktreeId: args.worktreeId,
        tabId: args.tabId
      }) ?? toHostSessionTabId(args.tabId)
    if (isClose) {
      // Why: suppress until the host confirms removal, else an in-flight pre-close snapshot flashes the tab back.
      closeIntentTabIds.add(hostTabId)
      recordWebSessionCloseIntent(intentOwner, args.worktreeId, hostTabId, Date.now())
    }
    const response = await callEnvironment({
      // Why: old hosts cannot route this additive method, so a generation
      // cutover fails closed before their destructive legacy close handler.
      method: isLifecycleClose ? 'session.tabs.closeLifecycle' : method,
      params: {
        worktree: toRuntimeWorktreeSelector(args.worktreeId),
        tabId: hostTabId,
        ...(method === 'session.tabs.activate'
          ? {
              // Why: the additive intent protects new hosts while notifyClients:false protects old hosts.
              notifyClients: false,
              navigation: 'caller' as const
            }
          : {}),
        ...(isLifecycleClose
          ? {
              reason: args.reason,
              publicationEpoch: args.publicationEpoch,
              terminal: args.terminalHandle
            }
          : isClose
            ? { reason: args.reason }
            : {})
      },
      timeoutMs: 15_000
    })
    const result = unwrapRuntimeRpcResult(
      response as RuntimeRpcResponse<RuntimeMobileSessionTabCloseResult | undefined>
    )
    if (isClose) {
      if (result?.refused === true && result.snapshotRepublished === true) {
        // Why: the host kept an authoritative live PTY. Stop hiding its mirror
        // only when it republished; dead-leaf refusals must stay suppressed.
        clearWebSessionCloseIntent(intentOwner, args.worktreeId, immediateHostTabId)
        clearWebSessionCloseIntent(intentOwner, args.worktreeId, hostTabId)
        const { acceptReplayedWebSessionTabsSnapshot } = await import('./web-session-tabs-sync')
        acceptReplayedWebSessionTabsSnapshot(environmentId, args.worktreeId)
      }
      await refreshWebRuntimeSessionTabsSnapshot(environmentId, args.worktreeId, {
        expectedEnvironmentPairingRevision: intentOwner.pairingRevision
      })
    }
    return true
  } catch (error) {
    for (const hostTabId of closeIntentTabIds) {
      clearWebSessionCloseIntent(intentOwner, args.worktreeId, hostTabId)
    }
    if (isLifecycleClose) {
      const { acceptReplayedWebSessionTabsSnapshot } = await import('./web-session-tabs-sync')
      acceptReplayedWebSessionTabsSnapshot(environmentId, args.worktreeId)
      await refreshWebRuntimeSessionTabsSnapshot(environmentId, args.worktreeId, {
        expectedEnvironmentPairingRevision: intentOwner.pairingRevision
      })
    }
    console.warn(
      `[web-runtime-session] failed to ${isClose ? 'close' : 'activate'} tab:`,
      error instanceof Error ? error.message : String(error)
    )
    return false
  }
}

export function splitWebRuntimeTerminal(
  ptyId: string | null | undefined,
  direction: 'horizontal' | 'vertical',
  telemetrySource: TerminalPaneSplitSource
): boolean {
  if (!ptyId) {
    return false
  }
  const remote = parseRemoteRuntimePtyId(ptyId)
  const environmentId = remote?.environmentId?.trim()
  if (!remote || !environmentId || !isWebRuntimeSessionActive(environmentId)) {
    return false
  }

  // Why: split must run on the host pane; a local split mints a web-only pane the host mirrors back as a tab, not a split.
  const pendingMirrorSuppressionId = reservePendingWebRuntimeSplitMirrorTelemetry(ptyId, direction)
  const releasePendingMirrorSuppression = schedulePendingWebRuntimeSplitMirrorTelemetryRelease(
    ptyId,
    direction,
    pendingMirrorSuppressionId
  )
  void window.api.runtimeEnvironments
    .call({
      selector: environmentId,
      method: 'terminal.split',
      params: {
        terminal: remote.handle,
        direction,
        telemetrySource
      },
      timeoutMs: 15_000
    })
    .then((response) => {
      unwrapRuntimeRpcResult(response as RuntimeRpcResponse<{ split: RuntimeTerminalSplit }>)
    })
    .catch((error) => {
      releasePendingMirrorSuppression()
      console.warn(
        '[web-runtime-session] failed to split terminal:',
        error instanceof Error ? error.message : String(error)
      )
    })
  return true
}

export function consumePendingWebRuntimeSplitMirrorTelemetry(
  sourcePtyId: string | null | undefined,
  direction: 'horizontal' | 'vertical'
): boolean {
  if (!sourcePtyId) {
    return false
  }
  const key = getPendingWebRuntimeSplitMirrorTelemetryKey(sourcePtyId, direction)
  const ids = pendingWebRuntimeSplitMirrorTelemetry.get(key)
  const id = ids?.values().next().value
  if (!ids || !id) {
    return false
  }
  ids.delete(id)
  if (ids.size === 0) {
    pendingWebRuntimeSplitMirrorTelemetry.delete(key)
  }
  return true
}

function reservePendingWebRuntimeSplitMirrorTelemetry(
  sourcePtyId: string,
  direction: 'horizontal' | 'vertical'
): string {
  const id = String(++pendingWebRuntimeSplitMirrorTelemetryId)
  const key = getPendingWebRuntimeSplitMirrorTelemetryKey(sourcePtyId, direction)
  const ids = pendingWebRuntimeSplitMirrorTelemetry.get(key) ?? new Set<string>()
  ids.add(id)
  pendingWebRuntimeSplitMirrorTelemetry.set(key, ids)
  return id
}

function schedulePendingWebRuntimeSplitMirrorTelemetryRelease(
  sourcePtyId: string,
  direction: 'horizontal' | 'vertical',
  id: string
): () => void {
  let released = false
  const release = (): void => {
    if (released) {
      return
    }
    released = true
    releasePendingWebRuntimeSplitMirrorTelemetry(sourcePtyId, direction, id)
  }
  const timeout = globalThis.setTimeout(release, WEB_RUNTIME_SPLIT_MIRROR_SUPPRESSION_TTL_MS)
  return () => {
    globalThis.clearTimeout(timeout)
    release()
  }
}

function releasePendingWebRuntimeSplitMirrorTelemetry(
  sourcePtyId: string,
  direction: 'horizontal' | 'vertical',
  id: string
): void {
  const key = getPendingWebRuntimeSplitMirrorTelemetryKey(sourcePtyId, direction)
  const ids = pendingWebRuntimeSplitMirrorTelemetry.get(key)
  if (!ids) {
    return
  }
  ids.delete(id)
  if (ids.size === 0) {
    pendingWebRuntimeSplitMirrorTelemetry.delete(key)
  }
}

function getPendingWebRuntimeSplitMirrorTelemetryKey(
  sourcePtyId: string,
  direction: 'horizontal' | 'vertical'
): string {
  return `${direction}:${sourcePtyId}`
}

export function closeWebRuntimeTerminal(ptyId: string | null | undefined): boolean {
  if (!ptyId) {
    return false
  }
  const remote = parseRemoteRuntimePtyId(ptyId)
  const environmentId = remote?.environmentId?.trim()
  if (!remote || !environmentId || !isWebRuntimeSessionActive(environmentId)) {
    return false
  }

  // Why: host owns the real pane graph; close the host terminal first so later snapshots can't resurrect the removed pane.
  void window.api.runtimeEnvironments
    .call({
      selector: environmentId,
      method: 'terminal.close',
      params: {
        terminal: remote.handle
      },
      timeoutMs: 15_000
    })
    .then((response) => {
      unwrapRuntimeRpcResult(response as RuntimeRpcResponse<{ close: RuntimeTerminalClose }>)
    })
    .catch((error) => {
      console.warn(
        '[web-runtime-session] failed to close terminal pane:',
        error instanceof Error ? error.message : String(error)
      )
    })
  return true
}

// Why: pane geometry is host-authoritative for remote tabs; local-only changes revert on next snapshot, so push to host.
export async function updateWebRuntimePaneLayout(args: {
  worktreeId: string
  tabId: string
  root: TerminalPaneLayoutNode | null
  expandedLeafId: string | null
  titlesByLeafId?: Record<string, string>
}): Promise<boolean> {
  const environmentId =
    getRuntimeEnvironmentIdForWorktree(useAppStore.getState(), args.worktreeId) ?? null
  if (!environmentId || !isWebRuntimeSessionActive(environmentId)) {
    return false
  }
  const callEnvironment = captureRuntimeEnvironmentCall(environmentId)
  const hostTabId = isWebTerminalSurfaceTabId(args.tabId)
    ? toHostSessionTabId(args.tabId)
    : args.tabId
  try {
    const response = await callEnvironment({
      method: 'session.tabs.updatePaneLayout',
      params: {
        worktree: toRuntimeWorktreeSelector(args.worktreeId),
        tabId: hostTabId,
        root: args.root,
        expandedLeafId: args.expandedLeafId,
        ...(args.titlesByLeafId ? { titlesByLeafId: args.titlesByLeafId } : {})
      },
      timeoutMs: 15_000
    })
    unwrapRuntimeRpcResult(response as RuntimeRpcResponse<{ updated: true }>)
    return true
  } catch (error) {
    console.warn(
      '[web-runtime-session] failed to update pane layout:',
      error instanceof Error ? error.message : String(error)
    )
    return false
  }
}

// Why: tab color/pin are host-authoritative; mirror the change so it persists (undefined field = leave as-is on host).
export function setWebRuntimeTabProps(args: {
  worktreeId: string
  tabId: string
  color?: string | null
  isPinned?: boolean
  viewMode?: 'terminal' | 'chat'
}): boolean {
  const environmentId =
    getRuntimeEnvironmentIdForWorktree(useAppStore.getState(), args.worktreeId) ?? null
  if (!environmentId || !isWebRuntimeSessionActive(environmentId)) {
    return false
  }
  const callEnvironment = captureRuntimeEnvironmentCall(environmentId)
  const state = useAppStore.getState()
  void import('./web-session-tabs-sync')
    .then(({ resolveHostSessionTabIdForWebSessionTab }) => {
      const hostTabId =
        resolveHostSessionTabIdForWebSessionTab(state, {
          environmentId,
          worktreeId: args.worktreeId,
          tabId: args.tabId
        }) ?? (isWebTerminalSurfaceTabId(args.tabId) ? toHostSessionTabId(args.tabId) : args.tabId)
      return callEnvironment({
        method: 'session.tabs.setTabProps',
        params: {
          worktree: toRuntimeWorktreeSelector(args.worktreeId),
          tabId: hostTabId,
          ...(args.color !== undefined ? { color: args.color } : {}),
          ...(args.isPinned !== undefined ? { isPinned: args.isPinned } : {}),
          ...(args.viewMode !== undefined ? { viewMode: args.viewMode } : {})
        },
        timeoutMs: 15_000
      })
    })
    .then((response) => {
      unwrapRuntimeRpcResult(response as RuntimeRpcResponse<{ updated: true }>)
    })
    .catch((error) => {
      console.warn(
        '[web-runtime-session] failed to set tab props:',
        error instanceof Error ? error.message : String(error)
      )
    })
  return true
}

// Why: local pane.terminal.clear() is undone by the next host snapshot replay; clear the host buffer so it sticks.
export function clearWebRuntimeTerminalBuffer(ptyId: string | null | undefined): boolean {
  if (!ptyId) {
    return false
  }
  const remote = parseRemoteRuntimePtyId(ptyId)
  const environmentId = remote?.environmentId?.trim()
  if (!remote || !environmentId || !isWebRuntimeSessionActive(environmentId)) {
    return false
  }
  void window.api.runtimeEnvironments
    .call({
      selector: environmentId,
      method: 'terminal.clearBuffer',
      params: { terminal: remote.handle },
      timeoutMs: 15_000
    })
    .then((response) => {
      unwrapRuntimeRpcResult(response as RuntimeRpcResponse<{ clear: unknown }>)
    })
    .catch((error) => {
      console.warn(
        '[web-runtime-session] failed to clear terminal buffer:',
        error instanceof Error ? error.message : String(error)
      )
    })
  return true
}
