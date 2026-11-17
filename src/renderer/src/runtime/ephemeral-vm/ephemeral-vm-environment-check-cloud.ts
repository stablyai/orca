// Orca Cloud's part of the VM create's environment-check gate: stop only on a fatal check, show the
// rest as notices in the opened workspace, and put a blocked sandbox to sleep instead of billing.
import { useAppStore } from '@/store/index'
import { translate } from '@/i18n/i18n'
import type {
  EnvironmentDoctorCheck,
  EnvironmentDoctorResult
} from '../../../../shared/workspace-setup/environment-doctor/environment-doctor-types'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import {
  awaitVmEnvironmentCheckDecision,
  resolveVmEnvironmentCheckDecision,
  type VmEnvironmentCheckDecision
} from './ephemeral-vm-environment-check-decision'
import {
  environmentHeldNotice,
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

export type CloudFetchConfirm = (
  record: CloudSetupNoticesRecord,
  notice: CloudSetupNotice,
  runCheck: CloudCheckRunner
) => Promise<unknown>

/** Dev builds only: lets a real create exercise the unreachable-sandbox stop (and its sleep). */
export function throwIfSimulatedEnvCheckFault(): void {
  if (
    import.meta.env.DEV &&
    typeof localStorage !== 'undefined' &&
    localStorage.getItem('orca:dev:envCheckFault') === 'unreachable'
  ) {
    throw new Error('Simulated unreachable sandbox (orca:dev:envCheckFault).')
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
 * confirming check first: a fresh sandbox can miss its GitHub credential briefly.
 */
function publishCloudNotices(
  record: CloudSetupNoticesRecord,
  confirm: CloudFetchConfirm,
  runCheck: CloudCheckRunner
): void {
  const fetch = record.notices.find((notice) => notice.kind === 'fetch')
  const rest = {
    ...record,
    notices: record.notices.filter((notice) => notice !== fetch)
  }
  setCloudSetupNotices(rest)
  if (fetch) {
    void confirm(rest, fetch, runCheck).catch((error: unknown) => {
      console.warn('[orca-cloud] Could not re-check the sandbox reaching GitHub:', error)
    })
  }
}

export type CloudEnvironmentCheckGate = {
  /** Checks that stop the create (only fatal ones; the rest show in the workspace), or null to proceed. */
  blockingChecks: (result: EnvironmentDoctorResult) => EnvironmentDoctorCheck[] | null
  /** The create proceeds: show the non-fatal findings as notices in the opened workspace. */
  passed: (result: EnvironmentDoctorResult) => void
  /** Extra fields on the failed check: when the blocked sandbox will sleep. */
  failedFields: (failedAt: number) => { sleepsAt: number }
  backgroundFailedMessage: () => string
  /** Orca Cloud has its own (shorter) sleep in place of the recipe VM's hour-long pause timeout. */
  awaitDecision: (failedAt: number) => Promise<VmEnvironmentCheckDecision>
}

export function cloudEnvironmentCheckGate(args: {
  creationId: string
  environmentId: string
  path: string
  cloud: CloudEnvironmentCheckContext
  confirmFetch?: CloudFetchConfirm
  runCheck: CloudCheckRunner
}): CloudEnvironmentCheckGate {
  const { creationId, environmentId, path, cloud, runCheck } = args
  const confirmFetch = args.confirmFetch ?? confirmCloudFetchFailure
  const triage = (
    result: EnvironmentDoctorResult
  ): ReturnType<typeof triageCloudEnvironmentChecks> =>
    triageCloudEnvironmentChecks(result.checks, {
      setupRunsOnCreate: cloud.setupRunsOnCreate
    })
  return {
    blockingChecks: (result) => {
      const { fatal } = triage(result)
      return fatal.length > 0 ? fatal : null
    },
    passed: (result) => {
      const held = environmentHeldNotice(
        useAppStore.getState().pendingWorktreeCreations[creationId]?.provisioningLog
      )
      const { notices } = triage(result)
      publishCloudNotices(
        {
          environmentId,
          path: result.worktreePath || path,
          repoId: cloud.repoId,
          hostId: cloud.hostId,
          repoUrl: cloud.repoUrl,
          notices: held ? [held, ...notices] : notices
        },
        confirmFetch,
        runCheck
      )
    },
    failedFields: (failedAt) => ({
      sleepsAt: failedAt + BLOCKED_SANDBOX_SLEEP_MS
    }),
    backgroundFailedMessage: () =>
      translate(
        'auto.lib.ephemeralVmEnvironmentCheck.backgroundFailedCloud',
        'A new cloud workspace couldn’t start. Open it in the sidebar to continue.'
      ),
    awaitDecision: async (failedAt) => {
      const cancelSleep = scheduleBlockedSandboxSleep(creationId, cloud.runtimeId, failedAt)
      try {
        return await awaitVmEnvironmentCheckDecision(creationId, undefined)
      } finally {
        cancelSleep()
      }
    }
  }
}
