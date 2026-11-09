import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { runtimeEnvironmentSupportsCapability } from '@/runtime/rpc/compatibility/runtime-capability-proof'
import type {
  EnvironmentDoctorCheck,
  EnvironmentDoctorResult
} from '../../../shared/environment-doctor-types'
import {
  ENVIRONMENT_DOCTOR_METHOD,
  ENVIRONMENT_DOCTOR_RUNTIME_CAPABILITY
} from '../../../shared/environment-doctor-runtime'
import {
  awaitVmEnvironmentCheckDecision,
  beginVmEnvironmentCheckRun,
  endVmEnvironmentCheckRun
} from './ephemeral-vm-environment-check-decision'

// Two 20s network probes, local probes and a login-shell PATH refresh, with headroom for a slow VM.
const ENVIRONMENT_CHECK_TIMEOUT_MS = 150_000
// A paused build holds a running VM; give up after an hour so a forgotten one stops billing.
const PAUSE_TIMEOUT_MS = 60 * 60_000

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
async function runVmEnvironmentCheck(
  creationId: string,
  environmentId: string,
  path: string
): Promise<EnvironmentDoctorResult> {
  const signal = beginVmEnvironmentCheckRun(creationId)
  try {
    return await callRuntimeRpc<EnvironmentDoctorResult>(
      { kind: 'environment', environmentId },
      ENVIRONMENT_DOCTOR_METHOD,
      { path },
      { timeoutMs: ENVIRONMENT_CHECK_TIMEOUT_MS, signal }
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
    endVmEnvironmentCheckRun(creationId, signal)
  }
}

/**
 * Check the freshly provisioned VM before creating the workspace. A failure pauses the create on the
 * build sheet; it resolves true to continue (passed, unsupported, or "Open anyway") and false to cancel.
 * Nothing here tears the VM down: only cancelling does, so a degraded open keeps the VM that provisioned.
 */
export async function gateVmCreateOnEnvironmentCheck(
  creationId: string,
  environmentId: string,
  path: string
): Promise<boolean> {
  const update = useAppStore.getState().updatePendingWorktreeCreation
  const isPending = (): boolean =>
    Boolean(useAppStore.getState().pendingWorktreeCreations[creationId])
  if (!(await supportsEnvironmentChecks(environmentId))) {
    update(creationId, { environmentCheck: { status: 'skipped' } })
    return isPending()
  }
  for (;;) {
    // A dismiss during the probe or the previous pause registered nothing to abort.
    if (!isPending()) {
      return false
    }
    update(creationId, { environmentCheck: { status: 'running' } })
    const result = await runVmEnvironmentCheck(creationId, environmentId, path)
    if (!isPending()) {
      return false
    }
    if (result.ok) {
      update(creationId, { environmentCheck: { status: 'passed', checks: result.checks } })
      return true
    }
    update(creationId, { environmentCheck: { status: 'failed', checks: result.checks } })
    if (useAppStore.getState().activePendingCreationId !== creationId) {
      // The paused build keeps its VM running, so a background create must say it needs the user.
      toast.error(
        translate(
          'auto.lib.ephemeralVmEnvironmentCheck.backgroundFailed',
          'Environment checks failed for a new VM workspace. Open it in the sidebar to continue.'
        )
      )
    }
    const decision = await awaitVmEnvironmentCheckDecision(creationId, PAUSE_TIMEOUT_MS)
    if (decision === 'cancel' || !isPending()) {
      return false
    }
    if (decision === 'open-anyway') {
      toast.warning(
        translate(
          'auto.lib.ephemeralVmEnvironmentCheck.openedDegraded',
          'Creating the workspace on a VM whose environment checks failed.'
        )
      )
      return true
    }
  }
}
