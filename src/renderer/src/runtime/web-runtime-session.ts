/* eslint-disable max-lines */
import { toast } from 'sonner'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type {
  BrowserTabCreateResult,
  RuntimeMobileSessionCreateTerminalResult,
  RuntimeMobileSessionTabCloseResult,
  RuntimeMobileSessionTabMove,
  RuntimeMobileSessionTabMoveResult,
  RuntimeMobileSessionTabsResult,
  RuntimeSessionTabCloseReason,
  RuntimeTerminalCreate,
  RuntimeTerminalClose,
  RuntimeTerminalSplit
} from '../../../shared/runtime-types'
import type { TerminalPaneSplitSource } from '../../../shared/feature-education-telemetry'
import type { StartupCommandDelivery } from '../../../shared/codex-startup-delivery'
import type {
  SleepingAgentLaunchConfig,
  AgentProviderSessionMetadata
} from '../../../shared/agent-session-resume'
import { BROWSER_TAB_CREATE_KNOWN_ID_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { agentResumeHostAuthorityCapability } from './agent-resume-host-authority-capability'
import { expectsBrowserClientHosting } from '../../../shared/browser-client-hosting-eligibility'
import type {
  BrowserClientHostPlacementPreference,
  BrowserPageCreationPlacement
} from '../../../shared/browser-client-host-placement'
import type {
  AgentLaunchPreferences,
  AgentPromptDelivery,
  RuntimeCreateAgentSessionResult,
  RuntimeEnsureAgentSessionResult
} from '../../../shared/agent-session-host-authority'
import type { TerminalPaneLayoutNode } from '../../../shared/terminal-tab-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import { createBrowserUuid } from '../lib/browser-uuid'
import { getRuntimeEnvironmentIdForWorktree } from '../lib/worktree-runtime-owner'
import { useAppStore } from '../store'
import { hasRuntimeRpcErrorCode, unwrapRuntimeRpcResult } from './runtime-rpc-client'
import {
  createAgentSessionCreateOperation,
  withAgentSessionCreateOperationId
} from './agent-session-create-operation'
import { parseRemoteRuntimePtyId } from './runtime-terminal-stream'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'
import {
  clearWebSessionFocusIntentIfMatches,
  peekWebSessionFocusIntent,
  recordWebSessionFocusIntent,
  resolveWebSessionVisibleTabId
} from './web-session-focus-intent'
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
import {
  deliverLaunchPromptToAgentTab,
  seedNativeChatLaunchDraftForAgentTab
} from '../lib/agent-launch-prompt-delivery'
import {
  listRemoteRuntimeSessionTabsAfterCurrentInFlight,
  listRemoteRuntimeSessionTabsDeduped
} from './remote-runtime-session-tabs-inflight'
import { runRemoteAgentSessionLaunch } from './remote-agent-session-launch'
import { translate } from '../i18n/i18n'
import { getRuntimeEnvironmentRevision } from './runtime-environment-revision'
import { getRuntimeEnvironmentConnectionGeneration } from '@/store/slices/runtime-status'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { toRuntimeExecutionHostId } from '../../../shared/execution-host'
import {
  resolveWebRuntimeSessionEnvironmentId,
  shouldRestoreWebRuntimeSessionWorkspaceSelection,
  type WebRuntimeSessionWorkspaceSelection
} from './web-runtime-session-workspace-routing'
import {
  forgetWebSessionTerminalPlacement,
  recordWebSessionTerminalPlacement,
  webTerminalPlacementParentTabId
} from './web-session-terminal-placement'
import {
  claimWebSessionBrowserPlacementGroupCleanup,
  forgetWebSessionBrowserPlacement,
  markWebSessionBrowserPlacementGroupMaterialized,
  moveWebSessionBrowserPlacement,
  recordWebSessionBrowserPlacement,
  releaseWebSessionBrowserPlacementGroup
} from './web-session-browser-placement'
import { assertRuntimeManagedBrowserCreationAvailable } from '../lib/client-creation-action-policy'
import { hasMaterializedWebRuntimeBrowserPage } from './web-runtime-browser-materialization'
import { waitForWebRuntimeBrowserPageMaterialization } from './web-runtime-browser-materialization-wait'
import {
  discardStagedWebRuntimeBrowserTab,
  isStagedWebRuntimeBrowserTabLive,
  rehomeStagedWebRuntimeBrowserTab,
  resolveStagedWebRuntimeBrowserTabGroupId,
  restageWebRuntimeBrowserTabHostingIntent,
  stageWebRuntimeBrowserTab,
  StagedWebRuntimeBrowserTabCancelledError,
  type StagedWebRuntimeBrowserTab
} from './web-runtime-browser-tab-staging'
import {
  pauseAfterE2eWebRuntimeBrowserCreate,
  pauseDuringE2eWebRuntimeBrowserClientHostPreparation,
  throwIfE2eWebRuntimeBrowserCapabilityUnavailable,
  throwIfE2eWebRuntimeBrowserReconciliationFails
} from './web-runtime-browser-creation-e2e-fault'

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

const DEFINITIVE_BROWSER_CREATE_FAILURE_CODES = [
  'browser_error',
  'capability_unsupported',
  'invalid_argument',
  'invalid_params',
  'method_not_found',
  'runtime_rpc_queue_overloaded',
  'selector_ambiguous',
  'selector_not_found',
  'unauthorized'
] as const

function isDefinitiveBrowserCreateFailure(error: unknown): boolean {
  return DEFINITIVE_BROWSER_CREATE_FAILURE_CODES.some((code) => hasRuntimeRpcErrorCode(error, code))
}

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

type CreatedAgentTerminalIdentity = Pick<RuntimeTerminalCreate, 'tabId' | 'paneKey'> & {
  leafId?: string
}

function createdTerminalLeafId(terminal: CreatedAgentTerminalIdentity): string | undefined {
  const pane = parsePaneKey(terminal.paneKey ?? '')
  return pane && pane.tabId === terminal.tabId ? pane.leafId : undefined
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

/**
 * Launch a web-host agent terminal whose draft already rode in on the launch
 * command (argv prefill). No post-ready paste runs for that delivery, so seed
 * the chat-composer copy here once the mirrored host tab id is known.
 */
export async function createWebRuntimeAgentSessionTerminalWithLaunchDraft(
  args: CreateWebRuntimeSessionTerminalArgs & {
    agent: TuiAgent
    launchDraft: string
  }
): Promise<WebRuntimeTerminalCreateOutcome> {
  const created = await createWebRuntimeSessionTerminalResult(args)
  if (created.outcome.status !== 'failed' && created.hostTabId) {
    seedNativeChatLaunchDraftForAgentTab({
      tabId: toWebTerminalSurfaceTabId(created.hostTabId),
      agent: args.agent,
      text: args.launchDraft
    })
  }
  return created.outcome
}

async function createWebRuntimeSessionTerminalResult(
  args: CreateWebRuntimeSessionTerminalArgs
): Promise<CreatedWebRuntimeSessionTerminal> {
  const environmentId = resolveWebRuntimeSessionEnvironmentId(
    args.environmentId,
    useAppStore.getState().settings?.activeRuntimeEnvironmentId
  )
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

  let workspaceSelectionRollback: WebRuntimeSessionWorkspaceSelectionRollback | null = null
  if (args.selectWorktree !== false) {
    const previous = readActiveWorkspaceSelection()
    selectWebRuntimeSessionWorktree(args.worktreeId, environmentId)
    workspaceSelectionRollback = {
      previous,
      applied: {
        worktreeId: args.worktreeId,
        executionHostId: toRuntimeExecutionHostId(environmentId)
      }
    }
  }
  let hostCreated = false
  let createdTabId: string | undefined
  let createdLeafId: string | undefined
  try {
    const agent = args.launchAgent ?? args.agent
    const agentArgsOverride =
      args.agentArgs !== undefined ? args.agentArgs : args.launchConfig?.agentArgs
    if (agent) {
      let legacyAlreadyPlacedInGroup = false
      // Why: structured creation cannot yet express afterTabId; keep the exact legacy placement contract until it can.
      // Why: focus belongs to the paired client; a headless execution host has no renderer to focus.
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
                      ...(args.launchConfig?.ompResumeFilePath
                        ? { ompResumeFilePath: args.launchConfig.ompResumeFilePath }
                        : {}),
                      ...(agentArgsOverride !== undefined ? { agentArgs: agentArgsOverride } : {}),
                      ...(args.launchPreferences
                        ? { launchPreferences: args.launchPreferences }
                        : {}),
                      presentation: 'background'
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
                        presentation: 'background'
                      },
                      clientOperationId
                    ),
                    timeoutMs: 15_000
                  })) as RuntimeRpcResponse<RuntimeCreateAgentSessionResult>
                )
              )
      const resumeHostAuthorityCapability =
        args.agentSessionKind === 'resume' ? agentResumeHostAuthorityCapability(agent) : undefined
      const created = await runRemoteAgentSessionLaunch<{
        terminal: CreatedAgentTerminalIdentity
      }>({
        environmentId,
        ...(hostAuthority ? { hostAuthority } : {}),
        ...(resumeHostAuthorityCapability
          ? { hostAuthorityCapability: resumeHostAuthorityCapability }
          : {}),
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
          return {
            terminal: {
              tabId: legacyCreated.tab.id,
              leafId: legacyCreated.tab.leafId
            }
          }
        }
      })
      hostCreated = true
      createdTabId = created.terminal.tabId
      createdLeafId = legacyAlreadyPlacedInGroup
        ? created.terminal.leafId
        : createdTerminalLeafId(created.terminal)
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
      createdLeafId = created.tab.leafId
    }
    if (args.targetGroupId && createdTabId) {
      // Why: the host drops client-minted group ids, so this client's own record is what
      // lands the mirrored tab in the requested pane under client-owned placement.
      recordWebSessionTerminalPlacement({
        environmentId,
        worktreeId: args.worktreeId,
        hostTabId: webTerminalPlacementParentTabId(createdTabId),
        groupId: args.targetGroupId
      })
    }
    if (args.activate !== false && createdTabId && matchesWebSessionIntentOwner(intentOwner)) {
      // Why: record focus intent so the reconcile follows the snapshot's active
      // tab to THIS new terminal, instead of sticky-keeping the prior tab.
      recordWebSessionFocusIntent(intentOwner, args.worktreeId, createdTabId, createdLeafId)
    }
    await refreshWebRuntimeSessionTabsSnapshot(environmentId, args.worktreeId, {
      expectedEnvironmentPairingRevision: intentOwner.pairingRevision,
      // Why: the publication can beat the RPC response; replay it once after caller intent exists.
      acceptCurrentSnapshot:
        Boolean(createdTabId) && (args.activate !== false || Boolean(args.targetGroupId)),
      // Why: a placement record needs a post-create list; a deduped in-flight one can predate it.
      ...(args.targetGroupId && createdTabId ? { afterCurrentInFlight: true } : {})
    })
    if (args.targetGroupId && createdTabId) {
      await settleWebRuntimeTerminalPlacement(
        environmentId,
        args.worktreeId,
        webTerminalPlacementParentTabId(createdTabId),
        { groupId: args.targetGroupId, activate: args.activate !== false }
      )
    }
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
    if (createdTabId) {
      // Why: a record that outlives the create flow could yank a user-dragged tab back later.
      forgetWebSessionTerminalPlacement({
        environmentId,
        worktreeId: args.worktreeId,
        hostTabId: webTerminalPlacementParentTabId(createdTabId)
      })
    }
    if (!hostCreated && workspaceSelectionRollback) {
      restoreActiveWorkspaceSelection(workspaceSelectionRollback)
    }
    // Why: once the host accepted creation, reporting failure invites the user
    // to retry with a new operation ID and can duplicate a fresh agent.
    return {
      outcome: hostCreated ? { status: 'created' } : { status: 'failed', message },
      ...(createdTabId ? { hostTabId: createdTabId } : {})
    }
  }
}

/** Settle the placement once the mirrored tab exists (bounded poll), then consume the record. */
async function settleWebRuntimeTerminalPlacement(
  environmentId: string,
  worktreeId: string,
  hostTabId: string,
  placement: { groupId: string; activate: boolean }
): Promise<void> {
  const unifiedTabId = toWebTerminalSurfaceTabId(hostTabId)
  const findTab = () =>
    (useAppStore.getState().unifiedTabsByWorktree[worktreeId] ?? []).find(
      (tab) => tab.id === unifiedTabId
    )
  try {
    const deadline = Date.now() + 10_000
    while (!findTab() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    const tab = findTab()
    const state = useAppStore.getState()
    const targetGroupExists = (state.groupsByWorktree[worktreeId] ?? []).some(
      (group) => group.id === placement.groupId
    )
    if (tab && targetGroupExists && tab.groupId !== placement.groupId) {
      // Why: a snapshot can adopt the tab before the record exists (the publication races the
      // RPC response); repair through the same client-owned move a user drag takes.
      state.moveUnifiedTabToGroup(unifiedTabId, placement.groupId, {
        activate: placement.activate,
        recordInteraction: false
      })
    }
  } finally {
    forgetWebSessionTerminalPlacement({ environmentId, worktreeId, hostTabId })
  }
}

export async function createWebRuntimeSessionBrowserTab(args: {
  worktreeId: string
  environmentId?: string | null
  url?: string
  profileId?: string | null
  targetGroupId?: string
  clientTargetGroupId?: string
  clientTargetGroupCreated?: boolean
  focusOnCreate?: boolean
  /** Wait until a renderer-backed host can publish the new page in its session snapshot. */
  waitForRegistration?: boolean
  selectWorktree?: boolean
  stagedTitle?: string
  stagedFocusAddressBar?: boolean
  failureLogMode?: 'details' | 'operation-only'
  placementPreference?: BrowserClientHostPlacementPreference
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
  const shouldFocusOnCreate = args.focusOnCreate !== false
  const shouldSelectWorktree = args.selectWorktree !== false
  const provisionalPageId = createBrowserUuid()
  const advertisedCapabilities =
    useAppStore.getState().runtimeStatusByEnvironmentId?.get(environmentId)?.status?.capabilities ??
    []
  const hostSupportsKnownPageId = advertisedCapabilities.includes(
    BROWSER_TAB_CREATE_KNOWN_ID_RUNTIME_CAPABILITY
  )
  // Why the same predicate the main process uses: this mounts the staged pane one round-trip
  // before prepareBrowserClientHostPlacement answers, so the two have to reach the same verdict
  // from the same inputs. A cached status disagreeing with the live one is corrected by
  // restageWebRuntimeBrowserTabHostingIntent below; it never decides the placement itself.
  const expectsClientHosting = expectsBrowserClientHosting({
    enabled: useAppStore.getState().settings?.browserClientHostedRemoteEnabled !== false,
    preference: args.placementPreference,
    deviceScope: useAppStore.getState().runtimeStatusByEnvironmentId?.get(environmentId)?.status
      ?.deviceScope,
    capabilities: advertisedCapabilities
  })
  let unsubscribeFocusGuard = (): void => {}
  let guardedPageId = provisionalPageId
  let createdPageId: string | null = null
  let createAttempted = false
  let staged: StagedWebRuntimeBrowserTab | null = null
  try {
    throwIfE2eWebRuntimeBrowserCapabilityUnavailable()
    assertRuntimeManagedBrowserCreationAvailable(useAppStore.getState(), environmentId)
    if (args.clientTargetGroupId) {
      recordWebSessionBrowserPlacement({
        environmentId,
        worktreeId: args.worktreeId,
        remotePageId: provisionalPageId,
        groupId: args.clientTargetGroupId,
        callerCreatedGroup: args.clientTargetGroupCreated
      })
    }
    if (shouldSelectWorktree) {
      selectWebRuntimeSessionBrowserWorktree(args.worktreeId, environmentId)
    }
    // Why: everything below this point is a host round-trip; stage the tab first so the strip
    // reacts to the click instead of to the runtime.
    staged = stageWebRuntimeBrowserTab({
      environmentId,
      worktreeId: args.worktreeId,
      remotePageId: provisionalPageId,
      activate: shouldFocusOnCreate,
      ...(args.url !== undefined ? { url: args.url } : {}),
      ...(args.stagedTitle !== undefined ? { title: args.stagedTitle } : {}),
      ...(args.profileId !== undefined ? { profileId: args.profileId } : {}),
      ...((args.clientTargetGroupId ?? args.targetGroupId)
        ? { targetGroupId: (args.clientTargetGroupId ?? args.targetGroupId) as string }
        : {}),
      ...(args.stagedFocusAddressBar !== undefined
        ? { focusAddressBar: args.stagedFocusAddressBar }
        : {}),
      clientHosted: expectsClientHosting
    })
    // Why: sample the focus expectation and arm its guard against the state staging just wrote,
    // before any await. Sampling after the client-host preparation round-trip baked a switch made
    // during it into the baseline, so the guard read the user's new tab as "hasn't moved" and
    // adoption stole focus back.
    const initialFocusState = shouldFocusOnCreate ? useAppStore.getState() : null
    const expectedActiveWorktreeId = initialFocusState?.activeWorktreeId
    const expectedActiveWorkspaceExecutionHostId = initialFocusState?.activeWorkspaceExecutionHostId
    const expectedCurrentLocalTabId = initialFocusState
      ? resolveWebSessionVisibleTabId(initialFocusState, args.worktreeId)
      : null
    if (shouldFocusOnCreate && matchesWebSessionIntentOwner(intentOwner)) {
      recordWebSessionFocusIntent(
        intentOwner,
        args.worktreeId,
        provisionalPageId,
        undefined,
        expectedCurrentLocalTabId
      )
      unsubscribeFocusGuard = useAppStore.subscribe((state, previousState) => {
        if (
          state.activeBrowserTabIdByWorktree === previousState.activeBrowserTabIdByWorktree &&
          state.activeFileIdByWorktree === previousState.activeFileIdByWorktree &&
          // Why: resolveWebSessionVisibleTabId now reads group state, so a group-only focus move
          // must re-evaluate it.
          state.activeGroupIdByWorktree === previousState.activeGroupIdByWorktree &&
          state.activeTabIdByWorktree === previousState.activeTabIdByWorktree &&
          state.activeTabType === previousState.activeTabType &&
          state.activeTabTypeByWorktree === previousState.activeTabTypeByWorktree &&
          state.activeWorktreeId === previousState.activeWorktreeId &&
          state.activeWorkspaceExecutionHostId === previousState.activeWorkspaceExecutionHostId &&
          state.groupsByWorktree === previousState.groupsByWorktree &&
          state.unifiedTabsByWorktree === previousState.unifiedTabsByWorktree
        ) {
          return
        }
        if (
          state.activeWorktreeId === expectedActiveWorktreeId &&
          state.activeWorkspaceExecutionHostId === expectedActiveWorkspaceExecutionHostId &&
          resolveWebSessionVisibleTabId(state, args.worktreeId) === expectedCurrentLocalTabId
        ) {
          return
        }
        clearWebSessionFocusIntentIfMatches(intentOwner, args.worktreeId, guardedPageId)
        unsubscribeFocusGuard()
      })
    }
    const placementPreference = args.placementPreference ?? 'auto'
    let placement: BrowserPageCreationPlacement = { kind: 'server' }
    // Why no cached-capability gate here: the renderer's runtime status can hold a pre-upgrade
    // "cannot client-host" verdict for a whole catalog TTL, and skipping the preparation on it
    // pinned a capable pair to server placement for that long. The preparation reads live status
    // and answers `server` for a runtime that truly cannot host, so staleness now costs a round
    // trip against an incapable host instead of the wrong placement. An unreachable host pays for
    // that on the failure path too: the probe's 15s ceiling, then the tabCreate behind it and the
    // cleanup close its non-definitive failure needs, where before the create never started.
    if (placementPreference !== 'server') {
      try {
        await pauseDuringE2eWebRuntimeBrowserClientHostPreparation()
        placement = await window.api.runtimeEnvironments.prepareBrowserClientHostPlacement({
          selector: environmentId,
          expectedPairingRevision: intentOwner.pairingRevision,
          preference: placementPreference
        })
      } catch (error) {
        console.warn('[web-runtime-session] failed to prepare client browser host:', error)
        throw new Error(
          translate(
            'browser.clientHosted.preparationFailed',
            "Couldn't start the remote browser on this desktop. Check the paired connection and try again."
          ),
          { cause: error }
        )
      }
    }
    if (staged) {
      staged = restageWebRuntimeBrowserTabHostingIntent(staged, {
        environmentId,
        remotePageId: provisionalPageId,
        clientHosted: placement.kind === 'client'
      })
    }
    createAttempted = true
    const navigateAfterCreate =
      args.waitForRegistration === true && args.url && args.url !== 'about:blank'
    const created = unwrapRuntimeRpcResult(
      (await callEnvironment({
        method: 'browser.tabCreate',
        params: {
          worktree: toRuntimeWorktreeSelector(args.worktreeId),
          url: navigateAfterCreate ? undefined : args.url,
          ...(hostSupportsKnownPageId ? { page: provisionalPageId } : {}),
          ...(placement.kind === 'client' ? { placement } : {}),
          profileId: args.profileId ?? undefined,
          activate: shouldFocusOnCreate,
          // Why: `activate` alone made every paired device — the host desktop included — jump to a
          // tab this client created. New hosts read `navigation`; old ones ignore it and keep
          // today's behavior, which is also what keeps their targetGroupId placement working.
          navigation: 'caller',
          // Why: place the new browser in the clicked split group so the host snapshot is authoritative for it (no left-snap).
          ...(args.targetGroupId ? { targetGroupId: args.targetGroupId } : {}),
          // Why: web clients need the local tab now; waiting for host webview registration makes the workspace appear to close.
          waitForRegistration: args.waitForRegistration ?? false
        },
        timeoutMs: 15_000
      })) as RuntimeRpcResponse<BrowserTabCreateResult>
    )
    createdPageId = created.browserPageId
    if (navigateAfterCreate) {
      void callEnvironment({
        method: 'browser.goto',
        params: {
          worktree: toRuntimeWorktreeSelector(args.worktreeId),
          page: created.browserPageId,
          url: args.url
        },
        timeoutMs: 15_000
      })
        .then((response) => unwrapRuntimeRpcResult(response))
        .catch((error) => {
          console.warn(
            '[web-runtime-session] created browser tab navigation failed:',
            error instanceof Error ? error.message : String(error)
          )
        })
    }
    await pauseAfterE2eWebRuntimeBrowserCreate(created.browserPageId)
    // Why: the strip's X on a staged tab only unwinds this client's rows — it cannot close a host
    // page whose id did not exist when the user clicked. Hand the cancel to the cleanup path in the
    // catch below, which already owns retiring an unreconciled host page.
    // Why (accepted bound): the host page has no name until the create answers, so a cancel during
    // that round-trip leaves it alive for up to the RPC timeout. That is the same bound the
    // unreconciled-cleanup path has always accepted, so no sweep is added for it.
    if (staged && !isStagedWebRuntimeBrowserTabLive(staged, args.worktreeId)) {
      throw new StagedWebRuntimeBrowserTabCancelledError()
    }
    if (created.browserPageId !== provisionalPageId) {
      moveWebSessionBrowserPlacement({
        environmentId,
        worktreeId: args.worktreeId,
        fromRemotePageId: provisionalPageId,
        toRemotePageId: created.browserPageId
      })
      if (staged) {
        staged = rehomeStagedWebRuntimeBrowserTab(staged, {
          environmentId,
          worktreeId: args.worktreeId,
          remotePageId: created.browserPageId
        })
      }
      const focusIntent = shouldFocusOnCreate
        ? peekWebSessionFocusIntent(intentOwner, args.worktreeId)
        : null
      if (focusIntent?.hostTabId === provisionalPageId) {
        recordWebSessionFocusIntent(
          intentOwner,
          args.worktreeId,
          created.browserPageId,
          undefined,
          focusIntent.expectedCurrentLocalTabId
        )
      }
      guardedPageId = created.browserPageId
    }
    try {
      await refreshWebRuntimeSessionTabsSnapshot(environmentId, args.worktreeId, {
        expectedEnvironmentPairingRevision: intentOwner.pairingRevision,
        acceptCurrentSnapshot: true,
        afterCurrentInFlight: true,
        errorMode: 'throw'
      })
    } catch (error) {
      if (
        !hasMaterializedWebRuntimeBrowserPage(
          useAppStore.getState(),
          environmentId,
          args.worktreeId,
          created.browserPageId,
          args.clientTargetGroupId ?? args.targetGroupId
        )
      ) {
        throw error
      }
    }
    const expectedGroupId =
      (staged ? resolveStagedWebRuntimeBrowserTabGroupId(staged, args.worktreeId) : undefined) ??
      args.clientTargetGroupId ??
      args.targetGroupId
    let materialized = hasMaterializedWebRuntimeBrowserPage(
      useAppStore.getState(),
      environmentId,
      args.worktreeId,
      created.browserPageId,
      expectedGroupId
    )
    if (!materialized) {
      materialized = await waitForWebRuntimeBrowserPageMaterialization({
        environmentId,
        worktreeId: args.worktreeId,
        remotePageId: created.browserPageId,
        ...(expectedGroupId ? { expectedGroupId } : {})
      })
    }
    if (!materialized && expectedGroupId) {
      // Why: an older runtime can honor creation but not group targeting; a live tab in
      // the wrong split beats destroying what the user just made.
      materialized = hasMaterializedWebRuntimeBrowserPage(
        useAppStore.getState(),
        environmentId,
        args.worktreeId,
        created.browserPageId
      )
      if (materialized) {
        console.warn(
          '[web-runtime-session] created browser tab landed outside the requested group:',
          expectedGroupId
        )
      }
    }
    if (!materialized) {
      throw new Error('The created browser tab did not materialize in the client.')
    }
    // Why: materialization only proves *some* workspace in this worktree carries the page — when the
    // host mirrors it under its own id, the predicate goes true even though the staged row the user
    // X-ed is gone. The whole materialization wait above is a live window for that X, so re-check the
    // row here before the stage is surrendered, or the create reports success and never retires the
    // host page.
    if (staged && !isStagedWebRuntimeBrowserTabLive(staged, args.worktreeId)) {
      throw new StagedWebRuntimeBrowserTabCancelledError()
    }
    // Why: materialization means the snapshot has taken ownership of these rows, so nothing
    // downstream may still unwind them as an optimistic stage.
    staged = null
    const remainingFocusIntent = shouldFocusOnCreate
      ? peekWebSessionFocusIntent(intentOwner, args.worktreeId)
      : null
    if (
      remainingFocusIntent?.hostTabId === guardedPageId &&
      remainingFocusIntent.expectedCurrentLocalTabId === expectedCurrentLocalTabId
    ) {
      clearWebSessionFocusIntentIfMatches(intentOwner, args.worktreeId, guardedPageId)
    }
    unsubscribeFocusGuard()
    if (args.clientTargetGroupId) {
      markWebSessionBrowserPlacementGroupMaterialized({
        worktreeId: args.worktreeId,
        groupId: args.clientTargetGroupId
      })
    }
    forgetWebSessionBrowserPlacement({
      environmentId,
      worktreeId: args.worktreeId,
      remotePageId: guardedPageId
    })
    return true
  } catch (error) {
    unsubscribeFocusGuard()
    // Why: unwind the optimistic tab before the cleanup round-trips below, so a failed create
    // does not leave a dead tab sitting in the strip for the length of browser.tabClose.
    if (staged) {
      discardStagedWebRuntimeBrowserTab(staged)
    }
    let recoveryError: unknown = null
    const createFailureDefinitive = isDefinitiveBrowserCreateFailure(error)
    const cleanupPageId =
      createdPageId ??
      (createAttempted && !createFailureDefinitive && hostSupportsKnownPageId
        ? provisionalPageId
        : null)
    const createOutcomeUnknown = !cleanupPageId && !createFailureDefinitive
    const ownsClientGroupCleanup = args.clientTargetGroupId
      ? releaseWebSessionBrowserPlacementGroup({
          environmentId,
          worktreeId: args.worktreeId,
          remotePageId: guardedPageId,
          groupId: args.clientTargetGroupId,
          callerCreatedGroup: args.clientTargetGroupCreated === true
        })
      : false
    if (!args.clientTargetGroupId) {
      forgetWebSessionBrowserPlacement({
        environmentId,
        worktreeId: args.worktreeId,
        remotePageId: guardedPageId
      })
    }
    if (cleanupPageId) {
      try {
        const closeResult = unwrapRuntimeRpcResult(
          (await callEnvironment({
            method: 'browser.tabClose',
            params: {
              worktree: toRuntimeWorktreeSelector(args.worktreeId),
              page: cleanupPageId
            },
            timeoutMs: 15_000
          })) as RuntimeRpcResponse<{ closed: boolean }>
        )
        if (!closeResult.closed) {
          throw new Error('The paired runtime did not close the unreconciled browser tab.')
        }
        await refreshWebRuntimeSessionTabsSnapshot(environmentId, args.worktreeId, {
          expectedEnvironmentPairingRevision: intentOwner.pairingRevision,
          afterCurrentInFlight: true,
          errorMode: 'throw'
        })
        if (
          hasMaterializedWebRuntimeBrowserPage(
            useAppStore.getState(),
            environmentId,
            args.worktreeId,
            cleanupPageId
          )
        ) {
          throw new Error('The closed browser tab remained materialized in the client.')
        }
      } catch (cleanupError) {
        if (
          !createdPageId &&
          hostSupportsKnownPageId &&
          hasRuntimeRpcErrorCode(cleanupError, 'browser_tab_not_found')
        ) {
          recoveryError = null
        } else {
          recoveryError = cleanupError
          console.warn(
            '[web-runtime-session] failed to clean up unreconciled browser tab:',
            cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
          )
        }
      }
    }
    if (shouldFocusOnCreate) {
      clearWebSessionFocusIntentIfMatches(intentOwner, args.worktreeId, guardedPageId)
    }
    if (
      args.clientTargetGroupId &&
      claimWebSessionBrowserPlacementGroupCleanup({
        worktreeId: args.worktreeId,
        groupId: args.clientTargetGroupId,
        ownsGroupCleanup: ownsClientGroupCleanup
      })
    ) {
      useAppStore.getState().closeEmptyGroup(args.worktreeId, args.clientTargetGroupId)
    }
    if (error instanceof StagedWebRuntimeBrowserTabCancelledError) {
      console.warn('[web-runtime-session] browser tab was closed before its create finished')
    } else if (args.failureLogMode === 'operation-only') {
      console.warn('[web-runtime-session] failed to create browser tab')
    } else {
      console.warn(
        '[web-runtime-session] failed to create browser tab:',
        error instanceof Error ? error.message : String(error)
      )
    }
    if (recoveryError) {
      throw new Error('The paired runtime could not recover the failed browser creation.', {
        cause: recoveryError
      })
    }
    if (!createAttempted) {
      throw error
    }
    if (createOutcomeUnknown) {
      throw new Error('The paired runtime did not confirm whether the browser tab was created.', {
        cause: error
      })
    }
    return false
  }
}

function selectWebRuntimeSessionWorktree(worktreeId: string, environmentId: string): void {
  useAppStore.getState().setActiveWorktree(worktreeId, toRuntimeExecutionHostId(environmentId))
}

type WebRuntimeSessionWorkspaceSelectionRollback = {
  previous: WebRuntimeSessionWorkspaceSelection
  applied: WebRuntimeSessionWorkspaceSelection
}

function readActiveWorkspaceSelection(): WebRuntimeSessionWorkspaceSelection {
  const state = useAppStore.getState()
  return {
    worktreeId: state.activeWorktreeId ?? null,
    executionHostId: state.activeWorkspaceExecutionHostId ?? null
  }
}

function restoreActiveWorkspaceSelection(
  rollback: WebRuntimeSessionWorkspaceSelectionRollback
): void {
  if (
    !shouldRestoreWebRuntimeSessionWorkspaceSelection({
      ...rollback,
      current: readActiveWorkspaceSelection()
    })
  ) {
    return
  }
  useAppStore
    .getState()
    .setActiveWorktree(rollback.previous.worktreeId, rollback.previous.executionHostId ?? undefined)
}

function selectWebRuntimeSessionBrowserWorktree(worktreeId: string, environmentId: string): void {
  const state = useAppStore.getState()
  if (
    state.activeWorktreeId !== worktreeId ||
    state.activeWorkspaceExecutionHostId !== toRuntimeExecutionHostId(environmentId)
  ) {
    state.setActiveWorktree(worktreeId, toRuntimeExecutionHostId(environmentId))
  }
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
    afterCurrentInFlight?: boolean
    errorMode?: 'warn' | 'throw'
  } = {}
): Promise<void> {
  const webSessionTabsSync = await import('./web-session-tabs-sync')
  const expectedEnvironmentPairingRevision =
    options.expectedEnvironmentPairingRevision ?? getRuntimeEnvironmentRevision(environmentId)
  const expectedEnvironmentConnectionGeneration =
    getRuntimeEnvironmentConnectionGeneration(environmentId)
  const expectedTrackingGeneration =
    webSessionTabsSync.getWebSessionTabsTrackingGeneration(environmentId)
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
    const listSessionTabs =
      options.confirmAgentSessionHandoff || options.afterCurrentInFlight
        ? listRemoteRuntimeSessionTabsAfterCurrentInFlight
        : listRemoteRuntimeSessionTabsDeduped
    if (options.afterCurrentInFlight) {
      throwIfE2eWebRuntimeBrowserReconciliationFails()
    }
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
    const {
      applyWebSessionTabsSnapshot,
      applyWebSessionTabsStorePatch,
      decideWebSessionTabsSnapshot
    } = webSessionTabsSync
    if (getRuntimeEnvironmentRevision(environmentId) !== expectedEnvironmentPairingRevision) {
      return
    }
    // Why: this list is the host answering, but only the frame's own decision
    // says whether that answer is evidence — a workspace the mirror never
    // writes is discarded with nothing accepted behind it.
    const decision = decideWebSessionTabsSnapshot(snapshot, environmentId)
    const settleMirror = applyWebSessionTabsStorePatch(
      (state) => {
        // Why: eager refreshes can resolve after the user switched worktrees; update tabs without stealing focus.
        const patch = decision.apply
          ? applyWebSessionTabsSnapshot(state, snapshot, environmentId)
          : state
        return patch === state ? state : patch
      },
      {
        frames: [
          {
            environmentId,
            worktreeId: snapshot.worktree,
            decision,
            expectedEnvironmentConnectionGeneration,
            expectedEnvironmentPairingRevision,
            expectedTrackingGeneration
          }
        ]
      },
      snapshot
    )
    settleMirror()
  } catch (error) {
    if (options.errorMode === 'throw') {
      throw error
    }
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
  return (await callWebRuntimeSessionTabMethod('session.tabs.activate', args)) === 'applied'
}

/**
 * Why 'unknown-tab' is its own outcome: it is the host's definitive answer that it has no such
 * tab, which is the only evidence that lets a client finish a teardown the host cannot. Every
 * other failure -- a dropped connection, a timeout -- is a "not now", and treating it the same
 * would tear down tabs a reachable host still holds.
 */
export type WebRuntimeSessionTabCloseOutcome = 'applied' | 'unknown-tab' | 'failed'

export async function closeWebRuntimeSessionTab(args: {
  worktreeId: string
  tabId: string
  environmentId?: string | null
  reason: RuntimeSessionTabCloseReason
  publicationEpoch?: string | null
  terminalHandle?: string | null
}): Promise<WebRuntimeSessionTabCloseOutcome> {
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
): Promise<WebRuntimeSessionTabCloseOutcome> {
  const environmentId =
    args.environmentId?.trim() ??
    useAppStore.getState().settings?.activeRuntimeEnvironmentId?.trim() ??
    null
  if (!environmentId || !isWebRuntimeSessionActive(environmentId)) {
    return 'failed'
  }
  const intentOwner = captureWebSessionIntentOwner(environmentId)
  const callEnvironment = captureRuntimeEnvironmentCall(environmentId, intentOwner.pairingRevision)
  const closeIntentTabIds = new Set<string>()
  let activationHostTabId: string | null = null

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
    return 'failed'
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
    } else {
      activationHostTabId = hostTabId
      recordWebSessionFocusIntent(intentOwner, args.worktreeId, hostTabId)
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
              // Why: the additive navigation target protects new hosts while notifyClients:false protects old hosts.
              notifyClients: false,
              navigation: 'caller' as const,
              // Why: every caller here is a tab click, shortcut, or palette pick —
              // the gesture that is supposed to wake a slept pane.
              intent: 'user' as const
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
    return 'applied'
  } catch (error) {
    if (activationHostTabId) {
      clearWebSessionFocusIntentIfMatches(intentOwner, args.worktreeId, activationHostTabId)
    }
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
    return hasRuntimeRpcErrorCode(error, 'tab_not_found') ? 'unknown-tab' : 'failed'
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
      const message = error instanceof Error ? error.message : String(error)
      // Why: a split that fails only in the console leaves the user with a pane that silently
      // never appears.
      toast.error(message)
      console.warn('[web-runtime-session] failed to split terminal:', message)
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
