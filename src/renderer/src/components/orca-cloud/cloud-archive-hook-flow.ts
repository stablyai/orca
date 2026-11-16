// ARCHIVE-HOOK: before Orca archives or deletes an Orca Cloud workspace, the repo's orca.yaml
// `scripts.archive` runs in the still-running VM (the control plane runs it, up to 2 min), so what
// the workspace started elsewhere (a preview database branch, say) stops billing. Its output and
// status show in a toast. A failure never silently blocks: the person sees the output and chooses
// "Archive anyway" or to keep the workspace. Asleep, it is woken for the hook only when the control
// plane knows the repo has one; the archive's Undo toast says so and offers "Skip hook".
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type {
  HostedArchiveHookFailure,
  HostedArchiveHookRun
} from '../../../../shared/hosted-sandbox/hosted-archive-hook-wire'
import type {
  CloudWorkspaceTarget,
  OrcaCloudWorkspaceApi
} from '../../../../shared/hosted-sandbox/cloud-workspace-api'

// The bridge itself, not the cloud workspace store: the worktree slice's delete imports this module.
function cloudWorkspaceApi(): OrcaCloudWorkspaceApi | null {
  return typeof window !== 'undefined' ? (window.api?.orcaCloudWorkspace ?? null) : null
}

/** Lines of output a toast shows; the full tail is in the VM's ~/.orca-sandbox/archive-hook/archive.log. */
const OUTPUT_LINES = 8

/** True when the workspace sleeps and its repo has a hook that hasn't run since it last woke. */
export async function cloudArchiveHookNeedsWake(target: CloudWorkspaceTarget): Promise<boolean> {
  const state = await cloudWorkspaceApi()
    ?.getArchiveHookState(target)
    .catch(() => null)
  return (
    state?.ok === true &&
    !state.value.running &&
    state.value.archived !== true &&
    state.value.memo === 'pending'
  )
}

export function archiveHookOutputTail(runs: readonly HostedArchiveHookRun[]): string {
  const text = runs
    .map((run) => run.output.trimEnd())
    .filter(Boolean)
    .join('\n')
  return text.split('\n').slice(-OUTPUT_LINES).join('\n')
}

/** Why it failed, in words: the exit, the deadline, or what kept it from running. */
export function describeArchiveHookFailure(result: HostedArchiveHookFailure): string {
  if (result.reason === 'wake_failed') {
    return translate('orcaCloudWorkspace.archiveHook.wakeFailed', 'The workspace didn’t wake up.')
  }
  if (
    result.reason === 'no_server' ||
    result.reason === 'no_answer' ||
    result.reason === 'unreachable'
  ) {
    return translate(
      'orcaCloudWorkspace.archiveHook.unreachable',
      'Orca couldn’t reach the workspace to run it.'
    )
  }
  if (result.reason === 'busy') {
    return translate(
      'orcaCloudWorkspace.archiveHook.busy',
      'It’s already running for this workspace.'
    )
  }
  const timedOut = result.runs.find((run) => run.timedOut)
  if (timedOut) {
    return translate(
      'orcaCloudWorkspace.archiveHook.timedOut',
      'It didn’t finish within 2 minutes.'
    )
  }
  const exit = result.runs.find((run) => run.exitCode !== 0)?.exitCode
  return translate('orcaCloudWorkspace.archiveHook.exited', 'It exited with code {{code}}.', {
    code: exit ?? '?'
  })
}

export type CloudArchiveHookOutcome =
  | { kind: 'proceed' }
  | { kind: 'failed'; result: HostedArchiveHookFailure }

/** Runs the hook with a progress toast; answers what happened, never throws. */
export async function runCloudArchiveHook(
  workspaceId: string,
  options: { name?: string | null; wake: boolean; target: CloudWorkspaceTarget }
): Promise<CloudArchiveHookOutcome> {
  const bridge = cloudWorkspaceApi()
  if (!bridge) {
    return { kind: 'proceed' }
  }
  const toastId = `orca-cloud-archive-hook:${workspaceId}`
  const name = options.name ?? ''
  const timer = setTimeout(
    () =>
      toast.loading(
        options.wake
          ? translate(
              'orcaCloudWorkspace.archiveHook.waking',
              'Waking {{name}} to run its archive script…',
              { name }
            )
          : translate(
              'orcaCloudWorkspace.archiveHook.running',
              'Running {{name}}’s archive script…',
              {
                name
              }
            ),
        { id: toastId }
      ),
    // A workspace without a hook answers at once: no toast flashes for it.
    400
  )
  const answer = await bridge
    .runArchiveHook({ ...options.target, wake: options.wake })
    .catch((error: unknown) => ({
      ok: false as const,
      code: 'failed' as const,
      message: String(error)
    }))
  clearTimeout(timer)
  toast.dismiss(toastId)
  if (!answer.ok) {
    // A control plane from before this route answers not_found: nothing ran, nothing to report.
    if (answer.code === 'not_found' || answer.code === 'not_cloud') {
      return { kind: 'proceed' }
    }
    console.warn('[orca-cloud] archive hook request failed:', answer.message)
    return { kind: 'failed', result: { state: 'failed', runs: [], reason: 'unreachable' } }
  }
  const result = answer.value
  if (result.state === 'failed') {
    console.warn('[orca-cloud] archive hook failed', {
      workspaceId,
      reason: result.reason,
      exits: result.runs.map((run) => (run.timedOut ? 'timeout' : run.exitCode))
    })
    return { kind: 'failed', result: { ...result, state: 'failed' } }
  }
  if (result.state === 'succeeded') {
    const output = archiveHookOutputTail(result.runs)
    toast.success(
      translate('orcaCloudWorkspace.archiveHook.succeeded', '{{name}}’s archive script finished', {
        name
      }),
      output ? { description: output } : undefined
    )
  }
  return { kind: 'proceed' }
}

/**
 * The failed hook's output, with "Archive anyway" and "Keep it". Resolves true to go on. Closing the
 * toast keeps the workspace: nothing was archived yet, so that is the safe answer.
 */
export function askArchiveAnywayAfterHookFailure(
  workspaceId: string,
  result: HostedArchiveHookFailure,
  name?: string | null
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const settle = (value: boolean): void => {
      if (!settled) {
        settled = true
        resolve(value)
      }
    }
    const output = archiveHookOutputTail(result.runs)
    toast.error(
      translate('orcaCloudWorkspace.archiveHook.failedTitle', '{{name}}’s archive script failed', {
        name: name ?? ''
      }),
      {
        id: `orca-cloud-archive-hook-failed:${workspaceId}`,
        duration: Infinity,
        description: [describeArchiveHookFailure(result), output].filter(Boolean).join('\n'),
        action: {
          label: translate('orcaCloudWorkspace.archiveHook.archiveAnyway', 'Archive anyway'),
          onClick: () => {
            console.warn('[orca-cloud] archive hook failure waived; archiving anyway', {
              workspaceId
            })
            settle(true)
          }
        },
        cancel: {
          label: translate('orcaCloudWorkspace.archiveHook.keep', 'Keep it'),
          onClick: () => settle(false)
        },
        onDismiss: () => settle(false),
        onAutoClose: () => settle(false)
      }
    )
  })
}
