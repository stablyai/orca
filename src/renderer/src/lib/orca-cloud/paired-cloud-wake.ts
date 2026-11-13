// PAIRED-WAKE: wakes a PAIRED cloud workspace (a "<name> (cloud)" server bound to a sandbox; this
// desktop has no VM record to resume) through the control plane, with the same wake progress an
// owned workspace reports, so the waking overlay, predictive wake and billing refusals behave alike.
import { translate } from '@/i18n/i18n'
import type { CloudWakeSource } from '../../../../shared/hosted-sandbox/cloud-workspace-api'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import { resolveCloudRowSandboxId } from './cloud-host-rows'
import {
  getCloudWorkspaceSnapshot,
  isCloudWorkspaceArchived,
  noteCloudWakeProgress,
  refreshCloudWorkspaceStatus
} from './orca-cloud-workspace-store'

function notPairedMessage(): string {
  return translate(
    'auto.lib.orcaCloud.pairedWake.notPaired',
    'This workspace is no longer linked to this computer. Open it again from Cloud workspaces on Home.'
  )
}

// Paired rows this desktop put to sleep (their status read may not have caught up yet).
const sleptHere = new Set<string>()

/** Paired Sleep succeeded here: its status is re-read now, and an open wakes it even before that. */
export function notePairedCloudSlept(workspaceId: string): void {
  sleptHere.add(workspaceId)
  void refreshCloudWorkspaceStatus(workspaceId)
}

export type PairedWakeResult = { ok: true } | { ok: false; message: string; reason?: string }

/** Is this sidebar id a paired cloud workspace (registered by the paired registry)? */
export function isPairedCloudWorkspace(workspaceId: string): boolean {
  return workspaceId in getCloudWorkspaceSnapshot().paired
}

/**
 * Wakes it. `quiet` (predictive wake): no progress events, so a refusal leaves no card behind.
 * Otherwise reports waking → ready / failed like main does for an owned workspace.
 */
export async function wakePairedCloudWorkspace(
  workspaceId: string,
  options: { quiet?: boolean; source?: CloudWakeSource } = {}
): Promise<PairedWakeResult> {
  const environmentId = getCloudWorkspaceSnapshot().paired[workspaceId]
  if (!environmentId) {
    return { ok: false, message: notPairedMessage() }
  }
  const sandboxId = await resolveCloudRowSandboxId({
    id: workspaceId,
    hostId: toRuntimeExecutionHostId(environmentId)
  })
  if (!sandboxId) {
    return { ok: false, message: notPairedMessage() }
  }
  const startedAt = Date.now()
  const source = options.source ?? 'open'
  const report = (
    phase: 'waking' | 'ready' | 'failed',
    failure?: { message: string; reason?: string }
  ): void => {
    if (!options.quiet) {
      noteCloudWakeProgress({
        workspaceId,
        phase,
        source,
        startedAt,
        at: Date.now(),
        ...(failure ? { message: failure.message } : {}),
        // The plan refused it: the card says why (and offers plans), never the raw code.
        ...(failure?.message === 'entitlement_denied'
          ? { billingDenial: { reason: failure.reason ?? null } }
          : {})
      })
    }
  }
  report('waking')
  const result = await window.api.cloudWorkspaces.wake(sandboxId).catch((error: unknown) => ({
    ok: false as const,
    error: error instanceof Error ? error.message : String(error),
    reason: undefined
  }))
  if (result.ok) {
    sleptHere.delete(workspaceId)
    report('ready')
  } else {
    report('failed', { message: result.error, ...(result.reason ? { reason: result.reason } : {}) })
  }
  await refreshCloudWorkspaceStatus(workspaceId)
  return result.ok
    ? { ok: true }
    : { ok: false, message: result.error, ...(result.reason ? { reason: result.reason } : {}) }
}

/**
 * Opening a paired workspace's row: wakes it when it is asleep (the waking overlay and failure card
 * follow its progress), never when archived. Same outcome shape as an owned workspace's open.
 */
export async function wakePairedCloudWorkspaceIfAsleep(
  workspaceId: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  // Always a fresh read: a cached "ready" from before its Sleep (up to a poll old) made the first
  // open after Sleep skip the wake and sit in the dropped-connection retry (n38 GATE).
  await refreshCloudWorkspaceStatus(workspaceId)
  const entry = getCloudWorkspaceSnapshot().status[workspaceId]
  const state = entry?.error ? null : entry?.status?.state
  // Slept from here and the read failed: it is asleep as far as anyone knows, so wake it.
  const asleep = state === 'sleeping' || (state == null && sleptHere.has(workspaceId))
  if (!asleep || isCloudWorkspaceArchived(workspaceId)) {
    return { ok: true }
  }
  const result = await wakePairedCloudWorkspace(workspaceId, { source: 'open' })
  return result.ok ? { ok: true } : { ok: false, reason: result.message }
}
