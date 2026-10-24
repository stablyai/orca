import type { ExecutionHostId } from '../../../shared/execution-host'
import type { Worktree } from '../../../shared/worktree/types'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { useAppStore } from '@/store'
import type { AgentLaunchResult } from '../../../shared/agent-launch-intent'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { deriveAgentLaunchChildOperationId } from '../../../shared/agent-launch-child-operation'
import { isAgentLaunchReplayUnsupportedRefusal } from '../../../shared/agent-launch-replay-refusal'
import { runtimeRpcTargetForAuthorityKey } from '@/runtime/runtime-client-target'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import {
  getRuntimeEnvironmentRevision,
  isRuntimeEnvironmentContinuationPending
} from '@/runtime/runtime-environment-revision'
import {
  acceptHostCreatedWorktree,
  materializeHostCreatedWorktree
} from './worktree-creation-host-result'
import {
  settleHostCreatedLaunchResult,
  discardStructuredLaunchPrompts,
  markHostCreatedLaunchUnconfirmed
} from './structured-agent-session-launch-prompt'

import {
  desktopCreateAcceptedTerminal,
  type DesktopCreateLaunchRecord
} from './structured-agent-session-launch-record'
import {
  deleteStructuredAgentLaunchRecord,
  hasStructuredAgentLaunchCancellationTombstonePersisted,
  readStructuredAgentLaunchRecord,
  writeStructuredAgentLaunchRecords
} from './structured-agent-session-launch-persistence'

import { notifyStructuredLaunchListeners } from './structured-agent-session-launch-registry'

import {
  currentDesktopCreate,
  presentDesktopCreateWorkspace,
  removeDesktopCreateProvisional,
  acceptDesktopCreateCatalog as acceptCatalog,
  acceptDesktopCreateTopology as acceptTopology
} from './structured-agent-session-desktop-create-presentation'
import { cancelDesktopCreateLaunch as cancelLaunch } from './structured-agent-session-desktop-create-cancellation'
export {
  cancelDesktopCreateOnClose,
  retireDesktopCreatePresentation
} from './structured-agent-session-desktop-create-cancellation'

export function desktopCreateFailedWithoutEffects(error: unknown): boolean {
  return (
    error instanceof RuntimeRpcCallError &&
    [
      'worktree_create_collision',
      'agent_launch_surface_unavailable',
      'worktree_create_setup_choice_required'
    ].includes(error.code)
  )
}

/** The existing record owns Replay; pending is installed synchronously before transport awaits. */
export async function issueDesktopCreateLaunch(
  record: DesktopCreateLaunchRecord,
  target: RuntimeClientTarget,
  expectedEnvironmentPairingRevision?: number,
  initialIssue = false
): Promise<AgentLaunchResult | null> {
  const current = currentDesktopCreate(record)
  if (!current || current.lifecycle === 'pending') {
    return null
  }
  const revision = target.kind === 'environment' ? expectedEnvironmentPairingRevision : undefined
  const requestCurrent = (): boolean =>
    Boolean(currentDesktopCreate(record)) &&
    (target.kind === 'local' ||
      (revision !== undefined && getRuntimeEnvironmentRevision(target.environmentId) === revision))
  if (!requestCurrent()) {
    throw new Error('agent_session_operation_unknown')
  }
  writeStructuredAgentLaunchRecords([{ ...current, lifecycle: 'pending' }])
  notifyStructuredLaunchListeners(false)
  try {
    const result = await callRuntimeRpc<AgentLaunchResult>(
      target,
      'agent.launchReplay',
      structuredClone(record.desktopCreate.params),
      {
        timeoutMs: 10 * 60_000,
        ...(target.kind === 'environment' ? { expectedEnvironmentPairingRevision: revision } : {}),
        beforeSend: () => {
          if (!requestCurrent()) {
            throw new Error('agent_session_operation_unknown')
          }
        }
      }
    )
    if (!requestCurrent()) {
      return null
    }
    if (
      !result.worktreeId ||
      (currentDesktopCreate(record)?.desktopCreate.worktreeId &&
        currentDesktopCreate(record)?.desktopCreate.worktreeId !== result.worktreeId) ||
      (result.created && result.created.worktree.id !== result.worktreeId) ||
      (result.outcome.kind === 'structured' && result.outcome.sessionId !== record.sessionId) ||
      (currentDesktopCreate(record)?.[desktopCreateAcceptedTerminal] &&
        result.outcome.kind !== 'terminal') ||
      (result.outcome.kind === 'terminal' &&
        result.outcome.paneKey !== record.desktopCreate.params.paneKey)
    ) {
      throw new Error('agent_session_operation_unknown')
    }
    try {
      if (result.outcome.kind === 'structured') {
        presentDesktopCreateWorkspace(record, result.worktreeId, useAppStore.getState)
      }
    } catch (error) {
      console.warn('[structured-agent-launch] result presentation failed', error)
    }
    settleHostCreatedLaunchResult(record.sessionId, record.executionHostId, result)
    const child = deriveAgentLaunchChildOperationId(record.desktopCreate.params.operationId)
    const messageId = child && deriveAgentLaunchChildOperationId(child)
    const prompt = record.desktopCreate.params.prompt
    const settled =
      result.outcome.kind === 'terminal' ||
      !prompt?.text.trim() ||
      prompt.delivery === 'draft' ||
      result.prompt?.outcome === 'not-delivered' ||
      (result.prompt?.outcome === 'journaled' && result.prompt.messageId === messageId)
    const latest = currentDesktopCreate(record)
    if (!latest) {
      return null
    }
    if (settled) {
      if (result.outcome.kind === 'terminal') {
        removeDesktopCreateProvisional(latest, useAppStore.getState)
      }
      deleteStructuredAgentLaunchRecord(record.sessionId)
    } else {
      writeStructuredAgentLaunchRecords([{ ...latest, lifecycle: 'visibility-unknown' }])
    }
    notifyStructuredLaunchListeners(false)
    return result
  } catch (error) {
    const latest = currentDesktopCreate(record)
    if (!latest || !requestCurrent()) {
      return null
    }
    if (
      desktopCreateFailedWithoutEffects(error) ||
      (initialIssue &&
        error instanceof RuntimeRpcCallError &&
        isAgentLaunchReplayUnsupportedRefusal(error))
    ) {
      discardStructuredLaunchPrompts(record.sessionId)
      removeDesktopCreateProvisional(latest, useAppStore.getState)
      deleteStructuredAgentLaunchRecord(record.sessionId)
    } else {
      writeStructuredAgentLaunchRecords([{ ...latest, lifecycle: 'visibility-unknown' }])
      markHostCreatedLaunchUnconfirmed(record.sessionId)
      if (latest[desktopCreateAcceptedTerminal]) {
        removeDesktopCreateProvisional(latest, useAppStore.getState)
        deleteStructuredAgentLaunchRecord(record.sessionId)
      }
      const data = error instanceof RuntimeRpcCallError ? error.response.error.data : undefined
      const worktreeId =
        data &&
        typeof data === 'object' &&
        'desktopCreate' in data &&
        data.desktopCreate &&
        typeof data.desktopCreate === 'object' &&
        'worktreeId' in data.desktopCreate
          ? data.desktopCreate.worktreeId
          : undefined
      if (
        typeof worktreeId === 'string' &&
        worktreeId &&
        (!latest.desktopCreate.worktreeId || latest.desktopCreate.worktreeId === worktreeId)
      ) {
        try {
          presentDesktopCreateWorkspace(record, worktreeId, useAppStore.getState)
        } catch (observerError) {
          console.warn('[structured-agent-launch] workspace presentation failed', observerError)
        }
        if (record.desktopCreate.params.target.kind === 'create-worktree') {
          void acceptHostCreatedWorktree(
            target,
            { worktreeId },
            record.desktopCreate.params.target.create.repo.replace(/^id:/, ''),
            record.executionHostId,
            () => false,
            requestCurrent,
            revision
          ).catch((error: unknown) =>
            console.warn('[structured-agent-launch] workspace catalog acceptance failed', error)
          )
        }
      }
    }
    notifyStructuredLaunchListeners(false)
    throw error
  } finally {
    const latest = currentDesktopCreate(record)
    if (latest?.lifecycle === 'pending') {
      writeStructuredAgentLaunchRecords([{ ...latest, lifecycle: 'visibility-unknown' }])
      notifyStructuredLaunchListeners(false)
    }
  }
}

/** Deliberate chat Retry checks the frozen outer request, never the strict session-create route. */
export function retryDesktopCreateLaunch(worktreeId: string, sessionId: string): boolean {
  const record = readStructuredAgentLaunchRecord(sessionId)
  if (
    !record?.desktopCreate ||
    record.desktopCreate.worktreeId !== worktreeId ||
    record.lifecycle === 'pending'
  ) {
    return false
  }
  const target = runtimeRpcTargetForAuthorityKey(record.executionHostId)
  const known = useAppStore.getState().getKnownWorktreeById(worktreeId, record.executionHostId)
  if (
    !target ||
    !known ||
    record.desktopCreate.params.target.kind !== 'create-worktree' ||
    known.repoId !== record.desktopCreate.params.target.create.repo.replace(/^id:/, '')
  ) {
    return false
  }
  const revision =
    target.kind === 'environment' ? getRuntimeEnvironmentRevision(target.environmentId) : undefined
  if (
    target.kind === 'environment' &&
    (revision === undefined ||
      isRuntimeEnvironmentContinuationPending(target.environmentId, revision))
  ) {
    return false
  }
  void issueDesktopCreateLaunch(record, target, revision)
    .then(async (result) => {
      if (!result) {
        return
      }
      const responseCurrent = (): boolean =>
        !hasStructuredAgentLaunchCancellationTombstonePersisted(record.sessionId) &&
        (target.kind === 'local' ||
          getRuntimeEnvironmentRevision(target.environmentId) === revision)
      await acceptHostCreatedWorktree(
        target,
        result,
        known.repoId,
        record.executionHostId,
        () => false,
        responseCurrent,
        revision
      )
      if (responseCurrent()) {
        await materializeHostCreatedWorktree(target, result.worktreeId, revision)
      }
    })
    .catch((error: unknown) =>
      console.warn('[structured-agent-launch] outer Retry remains unconfirmed', error)
    )
  return true
}

export function acceptDesktopCreateCatalog(
  hostId: ExecutionHostId,
  rows: readonly Worktree[]
): void {
  acceptCatalog(hostId, rows, useAppStore.getState)
}

export function acceptDesktopCreateTopology(
  hostId: ExecutionHostId,
  snapshot: RuntimeMobileSessionTabsResult
): void {
  acceptTopology(hostId, snapshot, useAppStore.getState)
}

export function cancelDesktopCreateLaunch(
  launch: Parameters<typeof cancelLaunch>[0]
): Promise<void> {
  return cancelLaunch(launch, useAppStore.getState)
}
