import type { AppState } from '@/store/types'
import type { WorktreeCreationRequest } from './pending-worktree-creation'
import type { AgentLaunchCancelResult } from '../../../shared/agent-launch-cancellation'
import { recordHostCreatedLaunchMessage } from './structured-agent-session-host-launch-prompt'

import { cancelDesktopCreateOnClose } from './structured-agent-session-desktop-create-close'
export { cancelDesktopCreateOnClose } from './structured-agent-session-desktop-create-close'

import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'

import {
  getRuntimeEnvironmentRevision,
  resolveContinuedRuntimeEnvironmentRevision,
  isRuntimeEnvironmentContinuationPending
} from '@/runtime/runtime-environment-revision'

import {
  settleHostCreatedLaunchResult,
  discardStructuredLaunchPrompts
} from './structured-agent-session-launch-prompt'
import type { ExecutionHostId } from '../../../shared/execution-host'

import {
  deleteStructuredAgentLaunchRecord,
  markStructuredAgentLaunchCancelledPersisted,
  readStructuredAgentLaunchRecord
} from './structured-agent-session-launch-persistence'

import { notifyStructuredLaunchListeners } from './structured-agent-session-launch-registry'

import {
  currentDesktopCreate,
  removeDesktopCreateProvisional
} from './structured-agent-session-desktop-create-presentation'

/** Progress removal is synchronous; durable prevention never gates closing its view. */
export async function cancelDesktopCreateLaunch(
  launch: NonNullable<WorktreeCreationRequest['hostAgentLaunch']>,
  get: () => AppState
): Promise<void> {
  if (!launch.issued) {
    return
  }
  const record = readStructuredAgentLaunchRecord(launch.sessionId)
  if (!record?.desktopCreate || record.desktopCreate.params.operationId !== launch.operationId) {
    return
  }
  const target = launch.target
  const revision =
    target.kind === 'environment' && launch.pairingRevision !== undefined
      ? resolveContinuedRuntimeEnvironmentRevision(target.environmentId, launch.pairingRevision)
      : undefined
  const current = (): boolean =>
    Boolean(currentDesktopCreate(record)) &&
    (target.kind === 'local' ||
      (revision !== undefined &&
        getRuntimeEnvironmentRevision(target.environmentId) === revision &&
        launch.pairingRevision !== undefined &&
        !isRuntimeEnvironmentContinuationPending(target.environmentId, launch.pairingRevision)))
  if (!current()) {
    return
  }
  const result = await callRuntimeRpc<AgentLaunchCancelResult>(
    target,
    'agent.launchCancel',
    structuredClone(launch.params),
    {
      ...(target.kind === 'environment' ? { expectedEnvironmentPairingRevision: revision } : {}),
      beforeSend: () => {
        if (!current()) {
          throw new Error('agent_session_operation_unknown')
        }
      }
    }
  )
  if (!current()) {
    return
  }
  if (result.messageId) {
    recordHostCreatedLaunchMessage(record.sessionId, result.messageId)
  }
  if (result.status === 'cancelled') {
    discardStructuredLaunchPrompts(record.sessionId)
    deleteStructuredAgentLaunchRecord(record.sessionId)
    removeDesktopCreateProvisional(record, get)
    notifyStructuredLaunchListeners(false)
  } else if (result.result) {
    settleHostCreatedLaunchResult(record.sessionId, record.executionHostId, result.result)
  }
}

/** Explicit terminal close retires the same saved owner even after renderer restart. */
export function retireDesktopCreatePresentation(key: string, hostId?: ExecutionHostId): void {
  const record = readStructuredAgentLaunchRecord(key)
  if (!record?.desktopCreate || (hostId !== undefined && record.executionHostId !== hostId)) {
    return
  }
  markStructuredAgentLaunchCancelledPersisted(record.sessionId, record.executionHostId)
  discardStructuredLaunchPrompts(record.sessionId)
  cancelDesktopCreateOnClose(record)
  notifyStructuredLaunchListeners(false)
}
