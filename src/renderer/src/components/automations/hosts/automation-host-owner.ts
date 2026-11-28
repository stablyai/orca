/** The owner a surface that knows a record's execution host reads and writes through, captured once and re-checked before each use. */

import type { AutomationOwnerRef } from '../../../../../shared/automations/ownership/automation-owner-ref'
import { parseRoutableExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import {
  getRuntimeEnvironmentRevision,
  isRuntimeEnvironmentContinuationPending,
  resolveContinuedRuntimeEnvironmentRevision
} from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { getAutomationListedTargetFromHostId } from './automation-host-client'
import { automationRuntimePairingRevision } from './automation-authority-identity'

type EnvironmentsState = {
  runtimeEnvironments?: readonly { id: string; createdAt: number; pairingRevision?: number }[]
}

/**
 * The host's own (self-selector) owner, pinned to the pairing it has now. Null for a host this app
 * can't route to (SSH or unparseable): it is never mapped to this computer.
 */
export function automationOwnerForHostId(
  hostId: string,
  state: EnvironmentsState
): AutomationOwnerRef | null {
  const parsed = parseRoutableExecutionHostId(hostId)
  if (parsed?.kind !== 'local' && parsed?.kind !== 'runtime') {
    return null
  }
  // Paired web maps this computer to the server it is paired with, as the page's catalog does.
  const target = getAutomationListedTargetFromHostId(hostId, state)
  return automationOwnerForEnvironment(
    target.kind === 'environment' ? target.environmentId : null,
    state
  )
}

/** The self owner of this computer (null) or of a paired runtime, pinned to its pairing now. */
export function automationOwnerForEnvironment(
  environmentId: string | null,
  state: EnvironmentsState
): AutomationOwnerRef {
  if (environmentId === null) {
    return { authority: { kind: 'desktop' }, selector: { kind: 'self' } }
  }
  return {
    authority: {
      kind: 'runtime',
      environmentId,
      pairingRevision: automationRuntimePairingRevision(
        state.runtimeEnvironments ?? [],
        environmentId
      )
    },
    selector: { kind: 'self' }
  }
}

/**
 * Whether a captured owner still names the machine it was captured on.
 * - `same`: unchanged. `continued`: re-paired to the same machine; `owner` is the re-keyed one.
 * - `checking`: a re-pair is still proving its host, so nothing may be sent yet.
 * - `retired`: the pairing now names another machine. `unpaired`: the environment is gone.
 */
export type AutomationOwnerContinuity =
  | { status: 'same' | 'continued'; owner: AutomationOwnerRef }
  | { status: 'checking' | 'retired' | 'unpaired' }

export function evaluateAutomationOwner(owner: AutomationOwnerRef): AutomationOwnerContinuity {
  const { authority } = owner
  if (authority.kind !== 'runtime') {
    return { status: 'same', owner }
  }
  const { environmentId, pairingRevision: captured } = authority
  const current = getRuntimeEnvironmentRevision(environmentId)
  if (current === undefined) {
    return { status: 'unpaired' }
  }
  if (current === captured) {
    return { status: 'same', owner }
  }
  const resolved = resolveContinuedRuntimeEnvironmentRevision(environmentId, captured)
  if (resolved === current) {
    return {
      status: 'continued',
      owner: { ...owner, authority: { ...authority, pairingRevision: current } }
    }
  }
  if (isRuntimeEnvironmentContinuationPending(environmentId, resolved)) {
    return { status: 'checking' }
  }
  return { status: 'retired' }
}
