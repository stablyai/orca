import { captureHostWorktreeLaunchRequest } from './worktree-creation-host-request'
import {
  issueDesktopCreateLaunch,
  desktopCreateFailedWithoutEffects
} from './structured-agent-session-desktop-create'
import {
  readStructuredAgentLaunchRecord,
  writeStructuredAgentLaunchRecord,
  deleteStructuredAgentLaunchRecord,
  hasStructuredAgentLaunchCancellationTombstonePersisted
} from './structured-agent-session-launch-persistence'

import { useAppStore } from '@/store'
import { completeHostWorktreeCreation } from '@/lib/worktree-creation-host-completion'
import {
  stageHostCreatedLaunchPrompt,
  discardStructuredLaunchPrompts
} from '@/lib/structured-agent-session-launch-prompt'
import { deliverLaunchPromptToAgentTab } from '@/lib/agent-launch-prompt-delivery'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { structuredAgentSessionTabId } from '../../../shared/structured-agent-session-projection'

import { repoOwnerHostId, runtimeTargetForRepoOwner } from '@/lib/repo-runtime-owner'
import { runtimeRpcTargetForAuthorityKey } from '@/runtime/runtime-client-target'
import { adoptFromEndpoint } from '@/store/adopt-from-endpoint'
import { ensureLocalRuntimeCapabilities } from '@/runtime/local-runtime-capabilities'
import { getRuntimeEnvironmentStatus } from '@/runtime/runtime-rpc-client'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { resolveWorktreeCreateParent } from '@/store/slices/worktrees/create/worktree-create-parent-pick'

import { isAgentLaunchReplayUnsupportedRefusal } from '../../../shared/agent-launch-replay-refusal'
import { formatAgentTypeLabel } from '../../../shared/agent-type-label'
import { translate } from '@/i18n/i18n'
import {
  AGENT_LAUNCH_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_REPLAY_REQUIRED_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_SURFACE_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_DESKTOP_CREATE_RUNTIME_CAPABILITY
} from '../../../shared/agent-launch-runtime-capability'

import {
  getRuntimeEnvironmentRevision,
  resolveContinuedRuntimeEnvironmentRevision,
  isRuntimeEnvironmentContinuationPending
} from '@/runtime/runtime-environment-revision'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { AgentLaunchResult } from '../../../shared/agent-launch-intent'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'

const DESKTOP_CREATE_CAPABILITIES = [
  AGENT_LAUNCH_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_REPLAY_REQUIRED_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_SURFACE_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_DESKTOP_CREATE_RUNTIME_CAPABILITY
]

function unconfirmedCreate(agent: TuiAgent): Error {
  return new Error(
    translate(
      'auto.lib.worktreeCreationThroughHost.unconfirmedCreate',
      'Could not confirm whether {{agent}} created the workspace. Retry to check the same request.',
      { agent: formatAgentTypeLabel(agent) }
    )
  )
}

/** Returns false only before effects, when the existing renderer route must handle this create. */
export async function createWorktreeThroughHost(
  creationId: string,
  request: WorktreeCreationRequest
): Promise<boolean> {
  if (
    !request.hostAgentLaunch &&
    (request.agentLaunchRoute !== 'structured-native-chat' ||
      !request.agent ||
      request.ephemeralVmRecipe ||
      request.ephemeralVmRuntimeId ||
      request.ephemeralVmCheckoutMode)
  ) {
    return false
  }
  const agent = request.hostAgentLaunch?.params.agent ?? request.agent
  if (!agent) {
    return false
  }
  const state = useAppStore.getState()
  const requestedHostId = request.workspaceRunContext?.hostId ?? request.executionHostId
  const target =
    request.hostAgentLaunch?.target ??
    (requestedHostId
      ? runtimeRpcTargetForAuthorityKey(requestedHostId)
      : runtimeTargetForRepoOwner(state, request.repoId))
  const ownerHostId =
    request.hostAgentLaunch?.executionHostId ??
    requestedHostId ??
    repoOwnerHostId(state, request.repoId)
  if (!target || !ownerHostId) {
    return false
  }
  if (!request.hostAgentLaunch?.issued) {
    let capabilities: readonly string[] | null
    try {
      capabilities =
        target.kind === 'local'
          ? await ensureLocalRuntimeCapabilities()
          : ((await getRuntimeEnvironmentStatus(target.environmentId)).capabilities ?? [])
    } catch {
      return false
    }
    if (!DESKTOP_CREATE_CAPABILITIES.every((capability) => capabilities?.includes(capability))) {
      return false
    }
  }
  if (!useAppStore.getState().pendingWorktreeCreations[creationId]) {
    return true
  }
  const executionHostId =
    request.hostAgentLaunch?.executionHostId ??
    adoptFromEndpoint(target, {
      kind: 'createdWorktree',
      requestedHostId,
      resolveOwnHostId: () => ownerHostId
    })
  const currentRevision =
    target.kind === 'environment' ? getRuntimeEnvironmentRevision(target.environmentId) : undefined
  const capturedRevision = request.hostAgentLaunch
    ? request.hostAgentLaunch.pairingRevision
    : currentRevision
  const requestRevision =
    target.kind === 'environment' && capturedRevision !== undefined
      ? resolveContinuedRuntimeEnvironmentRevision(target.environmentId, capturedRevision)
      : undefined
  if (
    target.kind === 'environment' &&
    (capturedRevision === undefined ||
      currentRevision === undefined ||
      requestRevision !== currentRevision ||
      isRuntimeEnvironmentContinuationPending(target.environmentId, capturedRevision))
  ) {
    throw unconfirmedCreate(agent)
  }
  const parent = resolveWorktreeCreateParent(state, request.parentWorktreeId, executionHostId)
  if (!request.hostAgentLaunch) {
    request.hostAgentLaunch = captureHostWorktreeLaunchRequest(
      creationId,
      request,
      state,
      agent,
      executionHostId,
      parent,
      target
    )
  }
  const reservation = request.hostAgentLaunch
  useAppStore.getState().updatePendingWorktreeCreation(creationId, { request })
  const replayed = reservation.issued
  const prompt = reservation.params.prompt
  if (!replayed && prompt?.text) {
    try {
      stageHostCreatedLaunchPrompt({
        sessionId: reservation.sessionId,
        operationId: reservation.operationId,
        paneKey: reservation.paneKey,
        text: prompt.text,
        target,
        executionHostId,
        agent: reservation.params.agent,
        delivery: prompt.text.trim() ? prompt.delivery : 'draft',
        presentDraft: (actual, text) => {
          if (actual.kind === 'structured') {
            useAppStore.getState().seedNativeChatLaunchDraft({
              tabId: structuredAgentSessionTabId(reservation.sessionId),
              agent: reservation.params.agent,
              text,
              createdAt: Date.now()
            })
          } else {
            void deliverLaunchPromptToAgentTab({
              tabId: actual.tabId,
              agent: reservation.params.agent,
              content: text,
              launchPty: Promise.resolve(actual.ptyId),
              submit: false,
              forcePaste: true
            }).catch((error: unknown) =>
              console.warn('worktree create: terminal draft presentation failed', error)
            )
          }
        },
        terminalNotice: (tabId, leafId, text, outcome) =>
          useAppStore.getState().seedNativeChatLaunchPrompt({
            tabId,
            paneKey: makePaneKey(tabId, leafId),
            agent: reservation.params.agent,
            text,
            createdAt: Date.now(),
            ...(outcome === 'not-delivered' ? { failed: true } : { unconfirmed: true })
          })
      })
    } catch (error) {
      console.error('worktree create: opening input presentation failed', error)
    }
  }
  if (!reservation.issued) {
    writeStructuredAgentLaunchRecord({
      sessionId: reservation.sessionId,
      executionHostId,
      agent,
      lifecycle: 'visibility-unknown',
      desktopCreate: { params: reservation.params }
    })
  }
  reservation.issued = true
  let launch: AgentLaunchResult
  try {
    const record = readStructuredAgentLaunchRecord(reservation.sessionId)
    if (!record?.desktopCreate) {
      return true
    }
    const result = await issueDesktopCreateLaunch(record, target, requestRevision, !replayed)
    if (!result) {
      return true
    }
    launch = result
  } catch (error) {
    if (
      !replayed &&
      error instanceof RuntimeRpcCallError &&
      isAgentLaunchReplayUnsupportedRefusal(error)
    ) {
      discardStructuredLaunchPrompts(reservation.sessionId)
      deleteStructuredAgentLaunchRecord(reservation.sessionId)
      delete request.hostAgentLaunch
      return false
    }
    if (desktopCreateFailedWithoutEffects(error)) {
      if (reservation.params.prompt) {
        request.launchDraftPrompt = reservation.params.prompt.text
      }
      delete request.hostAgentLaunch
    }
    if (
      error instanceof RuntimeRpcCallError &&
      (error.code === 'agent_session_operation_unknown' ||
        error.code === 'agent_session_operation_expired')
    ) {
      throw unconfirmedCreate(agent)
    }
    throw error
  }
  await completeHostWorktreeCreation({
    creationId,
    request,
    target,
    executionHostId,
    parent,
    launch,
    expectedEnvironmentPairingRevision: requestRevision,
    isCurrent: () =>
      !hasStructuredAgentLaunchCancellationTombstonePersisted(reservation.sessionId) &&
      (target.kind === 'local' ||
        getRuntimeEnvironmentRevision(target.environmentId) === requestRevision)
  })
  return true
}
