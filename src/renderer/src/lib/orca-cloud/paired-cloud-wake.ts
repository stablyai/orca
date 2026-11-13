// PAIRED-WAKE: wakes a PAIRED cloud workspace (a "<name> (cloud)" server bound to a sandbox; this
// desktop has no VM record to resume) through the control plane, with the same wake progress an
// owned workspace reports, so the waking overlay, predictive wake and billing refusals behave alike.
import { translate } from '@/i18n/i18n'
import type { CloudWakeSource } from '../../../../shared/hosted-sandbox/cloud-workspace-api'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import { resolveCloudRowSandboxId } from './cloud-host-rows'
import { beginWorkspaceWake } from '@/components/terminal-pane/input/wake-input-buffer'
import {
  getCloudWorkspaceSnapshot,
  isCloudWorkspaceArchived,
  noteCloudWakeProgress,
  refreshCloudWorkspaceStatus
} from './orca-cloud-workspace-store'

function notPairedMessage(): string {
  return translate(
    'auto.lib.orcaCloud.pairedWake.notPaired2',
    'This workspace is no longer linked to this computer. Use Open cloud workspace… to link it again.'
  )
}

// Paired rows this desktop put to sleep (their status read may not have caught up yet).
const sleptHere = new Set<string>()

/**
 * Paired Sleep succeeded here: its status is re-read now (resolved once read, so the sleep can keep
 * saying "going to sleep" until the row says Asleep), and an open wakes it even before that.
 */
export function notePairedCloudSlept(workspaceId: string): Promise<void> {
  sleptHere.add(workspaceId)
  return refreshCloudWorkspaceStatus(workspaceId).catch(() => undefined)
}

/** How often, and for how long, an explicit wake re-reads status until the VM runs. */
export const PAIRED_WAKE_POLL_MS = 1_500
export const PAIRED_WAKE_MAX_WAIT_MS = 120_000

function wakeStalledMessage(): string {
  return translate(
    'orcaCloudWorkspace.overlay.stalled',
    'Orca Cloud stopped responding while waking.'
  )
}

/** Re-reads status until it says running (true) or the wait runs out (false). Bounded: it stops. */
async function waitUntilRunning(workspaceId: string): Promise<boolean> {
  const deadline = Date.now() + PAIRED_WAKE_MAX_WAIT_MS
  for (;;) {
    await refreshCloudWorkspaceStatus(workspaceId)
    const entry = getCloudWorkspaceSnapshot().status[workspaceId]
    if (!entry?.error && entry?.status?.state === 'ready') {
      return true
    }
    if (Date.now() + PAIRED_WAKE_POLL_MS > deadline) {
      return false
    }
    await new Promise<void>((resolve) => setTimeout(resolve, PAIRED_WAKE_POLL_MS))
  }
}

/** Its pairing is gone: the waking card says so, with "Open cloud workspace…" to pair it again. */
function notPaired(workspaceId: string, quiet: boolean | undefined): PairedWakeResult {
  const message = notPairedMessage()
  if (!quiet) {
    const at = Date.now()
    noteCloudWakeProgress({
      workspaceId,
      phase: 'failed',
      source: 'open',
      startedAt: at,
      at,
      message,
      notPaired: true
    })
  }
  return { ok: false, message, reason: 'not_paired' }
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
    return notPaired(workspaceId, options.quiet)
  }
  const startedAt = Date.now()
  if (!options.quiet) {
    // PAIRED-WAKE-TYPE-THROUGH: hold typing from the press. Waiting for the 'waking' report (after
    // the bindings read below) let the first keys reach the asleep server's dead connection.
    beginWorkspaceWake(workspaceId, startedAt)
  }
  const sandboxId = await resolveCloudRowSandboxId({
    id: workspaceId,
    hostId: toRuntimeExecutionHostId(environmentId)
  })
  if (!sandboxId) {
    return notPaired(workspaceId, options.quiet)
  }
  const source = options.source ?? 'open'
  const report = (
    phase: 'waking' | 'connecting' | 'ready' | 'failed',
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
    // The control plane accepts the wake before the VM runs (it takes seconds more): "ready" only
    // once its status says so, or the overlay never outlasts its show delay (PAIRED-WAKING-OVERLAY).
    report('connecting')
    if (options.quiet) {
      await refreshCloudWorkspaceStatus(workspaceId)
    } else if (await waitUntilRunning(workspaceId)) {
      report('ready')
    } else {
      report('failed', { message: wakeStalledMessage() })
    }
  } else {
    report('failed', { message: result.error, ...(result.reason ? { reason: result.reason } : {}) })
    await refreshCloudWorkspaceStatus(workspaceId)
  }
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
