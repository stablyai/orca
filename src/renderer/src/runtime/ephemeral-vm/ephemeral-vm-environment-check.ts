import { toast } from 'sonner'
import { useAppStore } from '@/store/index'
import { translate } from '@/i18n/i18n'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { runtimeEnvironmentSupportsCapability } from '@/runtime/rpc/compatibility/runtime-capability-proof'
import type {
  EnvironmentDoctorCheck,
  EnvironmentDoctorResult
} from '../../../../shared/environment-doctor-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import {
  ENVIRONMENT_DOCTOR_METHOD,
  ENVIRONMENT_DOCTOR_RUNTIME_CAPABILITY
} from '../../../../shared/environment-doctor-runtime'
import {
  awaitVmEnvironmentCheckDecision,
  beginVmEnvironmentCheckRun,
  endVmEnvironmentCheckRun,
  resolveVmEnvironmentCheckDecision,
  type VmEnvironmentCheckDecision
} from './ephemeral-vm-environment-check-decision'
import {
  triageCloudEnvironmentChecks,
  type CloudSetupNotice
} from './ephemeral-vm-environment-check-triage'
import {
  setCloudSetupNotices,
  type CloudSetupNoticesRecord
} from '@/lib/orca-cloud/cloud-setup-notices-store'
import {
  confirmCloudFetchFailure,
  type CloudCheckRunner
} from '@/lib/orca-cloud/cloud-fetch-notice'

// Two 20s network probes, local probes and a login-shell PATH refresh, with headroom for a slow VM.
const ENVIRONMENT_CHECK_TIMEOUT_MS = 150_000
// A paused build holds a running VM; give up after an hour so a forgotten one stops billing.
const PAUSE_TIMEOUT_MS = 60 * 60_000
/** Orca Cloud: a create stopped on a fatal check puts its sandbox to sleep after this long unused. */
export const BLOCKED_SANDBOX_SLEEP_MS = 5 * 60_000

/** What the Orca Cloud gate needs beyond the VM: who to show notices to, and what runs on create. */
export type CloudEnvironmentCheckContext = {
  runtimeId: string | undefined
  /** The create runs the setup script itself, so "hasn't run yet" is not news. */
  setupRunsOnCreate: boolean
  repoId: string | null
  hostId: ExecutionHostId | null
  repoUrl: string | null
}

export type VmEnvironmentCheckGateResult = 'proceed' | 'stop' | 'restart'

async function supportsEnvironmentChecks(environmentId: string): Promise<boolean> {
  try {
    return await runtimeEnvironmentSupportsCapability(
      environmentId,
      ENVIRONMENT_DOCTOR_RUNTIME_CAPABILITY
    )
  } catch {
    // A failed probe reads as an older server, which keeps today's unchecked create.
    return false
  }
}

/** A call that could not finish is reported as a failed check, so the user decides instead of a silent skip. */
export async function runVmEnvironmentCheck(
  creationId: string | null,
  environmentId: string,
  path: string
): Promise<EnvironmentDoctorResult> {
  const signal = creationId ? beginVmEnvironmentCheckRun(creationId) : undefined
  try {
    // Dev builds only: lets a real create exercise the unreachable-sandbox stop (and its sleep).
    if (
      import.meta.env.DEV &&
      typeof localStorage !== 'undefined' &&
      localStorage.getItem('orca:dev:envCheckFault') === 'unreachable'
    ) {
      throw new Error('Simulated unreachable sandbox (orca:dev:envCheckFault).')
    }
    return await callRuntimeRpc<EnvironmentDoctorResult>(
      { kind: 'environment', environmentId },
      ENVIRONMENT_DOCTOR_METHOD,
      { path },
      { timeoutMs: ENVIRONMENT_CHECK_TIMEOUT_MS, ...(signal ? { signal } : {}) }
    )
  } catch (error) {
    const unreachable: EnvironmentDoctorCheck = {
      id: 'environment.doctor',
      category: 'workspace',
      status: 'fail',
      message: translate(
        'auto.lib.ephemeralVmEnvironmentCheck.unreachable',
        'The environment checks could not finish: {{error}}',
        { error: error instanceof Error ? error.message : String(error) }
      )
    }
    return { worktreePath: path, ok: false, checks: [unreachable] }
  } finally {
    if (creationId && signal) {
      endVmEnvironmentCheckRun(creationId, signal)
    }
  }
}

/** The user decided: fold the wait into pausedMs so the clock resumes where it stopped. */
export function resumeBuildClock(creationId: string, now = Date.now()): void {
  const state = useAppStore.getState()
  const entry = state.pendingWorktreeCreations[creationId]
  if (entry?.waitingSince === undefined) {
    return
  }
  state.updatePendingWorktreeCreation(creationId, {
    pausedMs: (entry.pausedMs ?? 0) + Math.max(0, now - entry.waitingSince),
    waitingSince: undefined,
    resumedAt: now
  })
}

/**
 * After BLOCKED_SANDBOX_SLEEP_MS unused, a blocked create's sandbox sleeps. No workspace owns it yet,
 * so the window's idle sleep never would. If it can't sleep, it is deleted: it must not keep billing.
 */
function scheduleBlockedSandboxSleep(
  creationId: string,
  runtimeId: string | undefined,
  failedAt: number
): () => void {
  const timer = setTimeout(() => {
    const state = useAppStore.getState()
    const entry = state.pendingWorktreeCreations[creationId]
    const check = entry?.environmentCheck
    if (check?.status !== 'failed' || check.finishedAt !== failedAt || check.sandbox) {
      return
    }
    const mark = (sandbox: 'sleeping' | 'asleep' | 'deleted'): void => {
      const current = useAppStore.getState().pendingWorktreeCreations[creationId]?.environmentCheck
      if (current?.status === 'failed' && current.finishedAt === failedAt) {
        useAppStore.getState().updatePendingWorktreeCreation(creationId, {
          environmentCheck: { ...current, sandbox }
        })
      }
    }
    const suspend = runtimeId ? window.api?.ephemeralVm?.suspendRuntime : undefined
    if (!suspend || !runtimeId) {
      mark('deleted')
      resolveVmEnvironmentCheckDecision(creationId, 'cancel')
      return
    }
    mark('sleeping')
    void suspend({ runtimeId })
      .catch((error: unknown) => ({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      }))
      .then((result) => {
        if (result.ok) {
          mark('asleep')
          return
        }
        console.warn('[orca-cloud] Could not put a blocked sandbox to sleep:', result.error)
        mark('deleted')
        resolveVmEnvironmentCheckDecision(creationId, 'cancel')
      })
  }, BLOCKED_SANDBOX_SLEEP_MS)
  return () => clearTimeout(timer)
}

/**
 * Shows what the create's check found in the opened workspace. A failed reach of origin waits for a
 * confirming check first (ENV-ORIGIN-TOAST): a fresh sandbox can miss its GitHub credential briefly.
 */
function publishCloudNotices(
  record: CloudSetupNoticesRecord,
  confirm: (
    record: CloudSetupNoticesRecord,
    notice: CloudSetupNotice,
    runCheck: CloudCheckRunner
  ) => Promise<unknown>
): void {
  const fetch = record.notices.find((notice) => notice.kind === 'fetch')
  const rest = { ...record, notices: record.notices.filter((notice) => notice !== fetch) }
  setCloudSetupNotices(rest)
  if (fetch) {
    void confirm(rest, fetch, runVmEnvironmentCheck).catch((error: unknown) => {
      console.warn('[orca-cloud] Could not re-check the sandbox reaching GitHub:', error)
    })
  }
}

/**
 * Check the freshly provisioned VM before creating the workspace. Orca Cloud stops only on a fatal
 * check (no checkout, no git, orcad unreachable); everything else opens the workspace and shows
 * there as a notice. Recipe VMs pause on any failed check. Resolves `proceed` to continue (passed,
 * unsupported, or "Open anyway"), `stop` to cancel, `restart` to cancel and start on a new sandbox.
 * Nothing here tears the VM down: only the caller does, so a degraded open keeps the VM.
 */
export async function gateVmCreateOnEnvironmentCheck(
  creationId: string,
  environmentId: string,
  path: string,
  cloud?: CloudEnvironmentCheckContext,
  confirmFetch: Parameters<typeof publishCloudNotices>[1] = confirmCloudFetchFailure
): Promise<VmEnvironmentCheckGateResult> {
  const update = useAppStore.getState().updatePendingWorktreeCreation
  const isPending = (): boolean =>
    Boolean(useAppStore.getState().pendingWorktreeCreations[creationId])
  if (!(await supportsEnvironmentChecks(environmentId))) {
    const at = Date.now()
    update(creationId, { environmentCheck: { status: 'skipped', startedAt: at, finishedAt: at } })
    return isPending() ? 'proceed' : 'stop'
  }
  for (;;) {
    // A dismiss during the probe or the previous pause registered nothing to abort.
    if (!isPending()) {
      return 'stop'
    }
    const startedAt = Date.now()
    update(creationId, { environmentCheck: { status: 'running', startedAt } })
    const result = await runVmEnvironmentCheck(creationId, environmentId, path)
    if (!isPending()) {
      return 'stop'
    }
    const triage = cloud
      ? triageCloudEnvironmentChecks(result.checks, {
          setupRunsOnCreate: cloud.setupRunsOnCreate
        })
      : null
    const blocking = triage ? triage.fatal.length > 0 : !result.ok
    if (!blocking) {
      update(creationId, {
        environmentCheck: {
          status: 'passed',
          checks: result.checks,
          startedAt,
          finishedAt: Date.now()
        }
      })
      if (cloud && triage) {
        publishCloudNotices(
          {
            environmentId,
            path: result.worktreePath || path,
            repoId: cloud.repoId,
            hostId: cloud.hostId,
            repoUrl: cloud.repoUrl,
            notices: triage.notices
          },
          confirmFetch
        )
      }
      return 'proceed'
    }
    const failedAt = Date.now()
    update(creationId, {
      environmentCheck: {
        status: 'failed',
        // Orca Cloud lists only what stopped it; the rest would show in the workspace.
        checks: triage ? triage.fatal : result.checks,
        startedAt,
        finishedAt: failedAt,
        ...(cloud ? { sleepsAt: failedAt + BLOCKED_SANDBOX_SLEEP_MS } : {})
      },
      waitingSince: failedAt
    })
    if (useAppStore.getState().activePendingCreationId !== creationId) {
      // The paused build keeps its VM running, so a background create must say it needs the user.
      toast.error(
        cloud
          ? translate(
              'auto.lib.ephemeralVmEnvironmentCheck.backgroundFailedCloud',
              'A new cloud workspace couldn’t start. Open it in the sidebar to continue.'
            )
          : translate(
              'auto.lib.ephemeralVmEnvironmentCheck.backgroundFailed',
              'Environment checks failed for a new VM workspace. Open it in the sidebar to continue.'
            )
      )
    }
    const cancelSleep = cloud
      ? scheduleBlockedSandboxSleep(creationId, cloud.runtimeId, failedAt)
      : () => {}
    let decision: VmEnvironmentCheckDecision
    try {
      // Orca Cloud has its own (shorter) sleep; recipe VMs give up after an hour.
      decision = await awaitVmEnvironmentCheckDecision(
        creationId,
        cloud ? undefined : PAUSE_TIMEOUT_MS
      )
    } finally {
      cancelSleep()
    }
    if (decision === 'cancel' || !isPending()) {
      return 'stop'
    }
    resumeBuildClock(creationId)
    if (decision === 'restart') {
      return 'restart'
    }
    if (decision === 'open-anyway') {
      toast.warning(
        translate(
          'auto.lib.ephemeralVmEnvironmentCheck.openedDegraded',
          'Creating the workspace on a VM whose environment checks failed.'
        )
      )
      return 'proceed'
    }
  }
}
