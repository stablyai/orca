/**
 * Owner-qualified automation requests for one authority.
 *
 * Every call carries the incarnation the caller captured: a runtime request is
 * pinned to its `pairingRevision` through the existing environment revision
 * guard, and an SSH-scoped request carries the registration generation the row
 * was fetched under. Responses are validated, never cast — an older host that
 * silently drops the selector answers with its whole authority, and committing
 * that would attribute other hosts' automations to the selected one.
 */

import { callRuntimeRpc, type RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
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
  // Why: the desktop authority is the in-process runtime, so the probe no-ops
  // there — its scoped contract ships with the client and can never lag it.
  await assertAuthorityCapability(
    authority,
    AUTOMATION_LIST_HOST_SCOPE_RUNTIME_CAPABILITY,
    AUTOMATION_LIST_HOST_SCOPE_UPDATE_REQUIRED_MESSAGE
  )
  return validated(await callAuthority(authority, 'automation.list', { selector }), selector)
}

/**
 * The one unscoped request an old runtime gets per refresh cycle. Its result is
 * partitioned client-side into every requested entry; it carries no owners and
 * no usage projection, so those rows stay view-only.
 */
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

/**
 * Deliberately unprobed, matching the mutation arms' *absence* of a probe here:
 * history is read-only, and an older host that ignores the precondition answers
 * with the rows it has rather than acting on a fence it never honoured.
 */
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

/**
 * The one fenced-mutation path every authority shares. Owned and orphan rows
 * differ in the precondition they fence with and in nothing else, so they
 * share the transport, the capability probe, and any check either later gains.
 */
async function updateFenced(
  authority: AutomationAuthorityRef,
  id: string,
  updates: AutomationUpdateInput,
  expectedOwner: AutomationOwnerPrecondition,
  destination?: AutomationDestination
): Promise<Automation> {
  await assertOwnerFencingSupported(authority)
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

/**
 * Orphan rows have no owner to key by, so the orphan precondition is the fence.
 * The authority is still known and still probed: an orphan on an out-of-date
 * host is refused for the same reason an owned row there is.
 *
 * No destination is accepted — moving a row needs a host it can move to.
 */
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

/**
 * An orphan keeps its history: reading past runs needs no host to run on, which
 * is why `ORPHAN_ACTIONS` allows it where execution is blocked.
 */
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
  const result = await callAuthority<{ automation: Automation }>(authority, 'automation.create', {
    ...toRuntimeAutomationCreateInput(input),
    destination
  })
  return result.automation
}
