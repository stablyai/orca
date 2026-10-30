/** Pin runtime pairing revisions and SSH registration generations to captured owners. Validate responses: an old host may ignore selectors and return other hosts’ rows. */

import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type {
  Automation,
  AutomationCreateInput,
  AutomationRun,
  AutomationRunsPage,
  AutomationUpdateInput
} from '../../../../shared/automations-types'
import type {
  AutomationListResult,
  AutomationListScopeSelector
} from '../../../../shared/automation-list-scope'
import { validateAutomationListResponse } from '../../../../shared/automation-list-response'
import type {
  AutomationAuthorityRef,
  AutomationOwnerRef
} from '../../../../shared/automation-owner-ref'
/** The one classifier every client shares; re-exported so call sites keep importing it from here. */
export { matchAutomationOwnerConflict } from '../../../../shared/automation-owner-conflict'
import type {
  AutomationDestination,
  AutomationOwnerPrecondition
} from '../../../../shared/automation-owner-precondition'
import {
  toRuntimeAutomationCreateInput,
  toRuntimeAutomationUpdateInput
} from './automation-host-client'
import {
  assertAuthorityCapability,
  assertExtraAgentArgsSupported,
  assertOwnerFencingSupported,
  assertAutomationCreateIdempotencySupported,
  AUTOMATION_LIST_HOST_SCOPE_RUNTIME_CAPABILITY,
  AUTOMATION_LIST_HOST_SCOPE_UPDATE_REQUIRED_MESSAGE,
  AutomationHostScopeUnsupportedError,
  REQUEST_TIMEOUT_MS
} from './automation-capability-probe'

export {
  AutomationHostScopeUnsupportedError,
  AUTHORITY_CAPABILITY_CONFIRMATION_TTL_MS,
  AUTHORITY_CAPABILITY_CONFIRMATION_MAX,
  resetAutomationCapabilityProbes
} from './automation-capability-probe'

export class AutomationListResponseError extends Error {
  readonly code = 'invalid_response'

  constructor(message: string) {
    super(message)
    this.name = 'AutomationListResponseError'
  }
}

export type ScopedAutomationList = AutomationListResult & {
  /** Rows dropped because their metadata was missing, duplicated, or scoped elsewhere. */
  invalidRows: number
}

function runtimeTarget(authority: AutomationAuthorityRef): RuntimeClientTarget {
  return authority.kind === 'desktop'
    ? { kind: 'local' }
    : { kind: 'environment', environmentId: authority.environmentId }
}

function scopeSelector(owner: AutomationOwnerRef): AutomationListScopeSelector {
  return owner.selector.kind === 'ssh'
    ? {
        kind: 'ssh',
        targetId: owner.selector.targetId,
        expectedTargetGeneration: owner.selector.targetGeneration
      }
    : { kind: 'self' }
}

/** Orphan rows have a known authority and no executable owner, so delete/pause fence on that instead. */
export const ORPHAN_OWNER_PRECONDITION: AutomationOwnerPrecondition = {
  selector: { kind: 'orphan' }
}

export function ownerPrecondition(owner: AutomationOwnerRef): AutomationOwnerPrecondition {
  return {
    selector:
      owner.selector.kind === 'ssh'
        ? {
            kind: 'ssh',
            targetId: owner.selector.targetId,
            targetGeneration: owner.selector.targetGeneration
          }
        : { kind: 'self' }
  }
}

async function callAuthority<TResult>(
  authority: AutomationAuthorityRef,
  method: string,
  params: unknown
): Promise<TResult> {
  return await callRuntimeRpc<TResult>(runtimeTarget(authority), method, params, {
    timeoutMs: REQUEST_TIMEOUT_MS,
    // Why: a same-id re-pair must invalidate this request instead of retargeting it.
    ...(authority.kind === 'runtime'
      ? { expectedEnvironmentPairingRevision: authority.pairingRevision }
      : {})
  })
}

function validated(raw: unknown, selector: AutomationListScopeSelector): ScopedAutomationList {
  const validation = validateAutomationListResponse(raw, selector)
  if (!validation.ok) {
    throw validation.error.code === 'unsupported_host_scope'
      ? new AutomationHostScopeUnsupportedError(validation.error.message)
      : new AutomationListResponseError(validation.error.message)
  }
  return { ...validation.result, invalidRows: validation.invalidRows }
}

export async function listScopedAutomations(
  authority: AutomationAuthorityRef,
  selector: AutomationListScopeSelector
): Promise<ScopedAutomationList> {
  // Desktop is in-process and ships this client’s scoped contract, so capability probing no-ops.
  await assertAuthorityCapability(
    authority,
    AUTOMATION_LIST_HOST_SCOPE_RUNTIME_CAPABILITY,
    AUTOMATION_LIST_HOST_SCOPE_UPDATE_REQUIRED_MESSAGE
  )
  return validated(await callAuthority(authority, 'automation.list', { selector }), selector)
}

/** Share one old-runtime call per refresh; client partitioning supplies view-only rows without invented owners or usage. */
export async function listLegacyAutomations(
  authority: AutomationAuthorityRef
): Promise<Automation[]> {
  if (authority.kind === 'desktop') {
    // Desktop storage ships the scoped contract in-process, so it never degrades.
    throw new AutomationListResponseError('The desktop authority always supports scoped lists.')
  }
  const raw = await callAuthority<unknown>(authority, 'automation.list', null)
  const automations = (raw as { automations?: unknown } | null)?.automations
  if (!Array.isArray(automations)) {
    throw new AutomationListResponseError('The host returned an unreadable automation list.')
  }
  return automations as Automation[]
}

/** Convenience wrapper for a row's own host; orphan scopes are requested with the selector form. */
export async function listAutomationsForOwner(
  owner: AutomationOwnerRef
): Promise<ScopedAutomationList> {
  return await listScopedAutomations(owner.authority, scopeSelector(owner))
}

/** Owned and orphan history reads do not probe. Old hosts may ignore preconditions and return their stored rows; read-only calls cannot mutate behind an unhonored fence. */
async function listRunsFenced(
  authority: AutomationAuthorityRef,
  automationId: string,
  expectedOwner: AutomationOwnerPrecondition,
  options: { limit?: number; cursor?: string } = {}
): Promise<AutomationRun[]> {
  const result = await callAuthority<{ runs: AutomationRun[] }>(authority, 'automation.runs', {
    automationId,
    expectedOwner,
    ...options
  })
  return result.runs
}

export async function listAutomationRunsForOwner(
  owner: AutomationOwnerRef,
  automationId: string
): Promise<AutomationRun[]> {
  return await listRunsFenced(owner.authority, automationId, ownerPrecondition(owner))
}

export async function listAutomationRunsPageForOwner(
  owner: AutomationOwnerRef,
  automationId: string,
  options: { limit?: number; cursor?: string } = {}
): Promise<AutomationRunsPage> {
  const result = await callAuthority<AutomationRunsPage | { runs: AutomationRun[] }>(
    owner.authority,
    'automation.runs',
    { automationId, expectedOwner: ownerPrecondition(owner), ...options }
  )
  return { runs: result.runs, nextCursor: 'nextCursor' in result ? result.nextCursor : null }
}

/** Share owned/orphan mutation transport and capability probing; only the fence precondition differs. */
async function updateFenced(
  authority: AutomationAuthorityRef,
  id: string,
  updates: AutomationUpdateInput,
  expectedOwner: AutomationOwnerPrecondition,
  destination?: AutomationDestination
): Promise<Automation> {
  await assertOwnerFencingSupported(authority)
  await assertExtraAgentArgsSupported(authority, updates.extraAgentArgs)
  const result = await callAuthority<{ automation: Automation }>(authority, 'automation.update', {
    id,
    updates: toRuntimeAutomationUpdateInput(updates),
    expectedOwner,
    destination
  })
  return result.automation
}

async function deleteFenced(
  authority: AutomationAuthorityRef,
  id: string,
  expectedOwner: AutomationOwnerPrecondition
): Promise<void> {
  await assertOwnerFencingSupported(authority)
  await callAuthority(authority, 'automation.delete', { id, expectedOwner })
}

export async function updateAutomationForOwner(
  owner: AutomationOwnerRef,
  id: string,
  updates: AutomationUpdateInput,
  destination?: AutomationDestination
): Promise<Automation> {
  return await updateFenced(owner.authority, id, updates, ownerPrecondition(owner), destination)
}

export async function deleteAutomationForOwner(
  owner: AutomationOwnerRef,
  id: string
): Promise<void> {
  await deleteFenced(owner.authority, id, ownerPrecondition(owner))
}

/** Fence orphan mutations with their known authority/orphan precondition and the same capability probe as owned rows. No destination is accepted. */
export async function updateOrphanAutomation(
  authority: AutomationAuthorityRef,
  id: string,
  updates: AutomationUpdateInput
): Promise<Automation> {
  return await updateFenced(authority, id, updates, ORPHAN_OWNER_PRECONDITION)
}

export async function deleteOrphanAutomation(
  authority: AutomationAuthorityRef,
  id: string
): Promise<void> {
  await deleteFenced(authority, id, ORPHAN_OWNER_PRECONDITION)
}

/** Orphans retain read-only history even though they cannot execute. */
export async function listOrphanAutomationRuns(
  authority: AutomationAuthorityRef,
  automationId: string
): Promise<AutomationRun[]> {
  return await listRunsFenced(authority, automationId, ORPHAN_OWNER_PRECONDITION)
}

export async function listOrphanAutomationRunsPage(
  authority: AutomationAuthorityRef,
  automationId: string,
  options: { limit?: number; cursor?: string } = {}
): Promise<AutomationRunsPage> {
  const result = await callAuthority<AutomationRunsPage | { runs: AutomationRun[] }>(
    authority,
    'automation.runs',
    { automationId, expectedOwner: ORPHAN_OWNER_PRECONDITION, ...options }
  )
  return { runs: result.runs, nextCursor: 'nextCursor' in result ? result.nextCursor : null }
}

export async function runAutomationNowForOwner(
  owner: AutomationOwnerRef,
  id: string
): Promise<AutomationRun> {
  await assertOwnerFencingSupported(owner.authority)
  const expectedOwner = ownerPrecondition(owner)
  const result = await callAuthority<{ run: AutomationRun }>(owner.authority, 'automation.runNow', {
    id,
    expectedOwner
  })
  return result.run
}

export async function createAutomationForDestination(
  authority: AutomationAuthorityRef,
  input: AutomationCreateInput,
  destination: AutomationDestination
): Promise<Automation> {
  if (input.creationKey) {
    await assertAutomationCreateIdempotencySupported(authority)
  }
  await assertOwnerFencingSupported(authority)
  // Why before create: a move is create-then-delete and must refuse before mutating anything.
  await assertExtraAgentArgsSupported(authority, input.extraAgentArgs)
  const result = await callAuthority<{ automation: Automation }>(authority, 'automation.create', {
    ...toRuntimeAutomationCreateInput(input),
    destination
  })
  return result.automation
}
