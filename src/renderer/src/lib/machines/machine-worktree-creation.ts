import { toast } from 'sonner'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { ProjectHostSetupResult } from '../../../../shared/project-types'
import { useAppStore } from '@/store'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import { appendProvisioningLog } from '@/lib/pending-creation-provisioning-log'
import {
  startMachine,
  subscribeMachineProgress,
  type MachineStep
} from '@/lib/machines/machine-start'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { resolveProjectCloneUrlPrefill } from '@/lib/project-clone-url-prefill'
import { getPortableBaseSelection } from '@/lib/portable-base-selection'
import { translate } from '@/i18n/i18n'
import { wakeMachine } from '@/lib/machines/machine-wake'
import { describeMachineFailure } from '@/lib/machines/machine-copy'

type MachineRequest = NonNullable<WorktreeCreationRequest['machine']>

function stillPending(creationId: string): boolean {
  return Boolean(useAppStore.getState().pendingWorktreeCreations[creationId])
}

/** Shows one plain sentence; the raw cause goes behind "Show log". */
function fail(creationId: string, error: string, detail?: string): null {
  const store = useAppStore.getState()
  if (!store.pendingWorktreeCreations[creationId]) {
    return null
  }
  if (detail) {
    appendProvisioningLog(creationId, `${detail.trimEnd()}\n`)
  }
  store.updatePendingWorktreeCreation(creationId, { status: 'error', error })
  if (store.activePendingCreationId !== creationId) {
    toast.error(error)
  }
  return null
}

/** A paired server's machine runs at the location already chosen; it only needs waking. */
async function wakePairedMachine(
  creationId: string,
  request: WorktreeCreationRequest,
  machine: MachineRequest,
  environmentId: string
): Promise<WorktreeCreationRequest | null> {
  useAppStore
    .getState()
    .updatePendingWorktreeCreation(creationId, { machineProgress: { activity: 'waking' } })
  const woken = await wakeMachine(
    { providerKey: machine.providerKey, machineId: machine.machineId },
    { environmentId }
  ).catch((error: unknown) => ({
    ok: false as const,
    code: 'unavailable' as const,
    message: error instanceof Error ? error.message : String(error)
  }))
  if (!stillPending(creationId)) {
    return null
  }
  if (!woken.ok) {
    return fail(
      creationId,
      `${translate('auto.lib.machines.machineStart.wakeFailed', 'Couldn’t wake {{name}}.', {
        name: machine.machineName
      })} ${describeMachineFailure(woken.code)}`,
      woken.message
    )
  }
  useAppStore.getState().updatePendingWorktreeCreation(creationId, { phase: 'fetching' })
  return request
}

/** Reuses the project's location on the machine, or clones it into the provider's project root. */
async function ensureProjectOnMachine(args: {
  projectId: string
  hostId: ExecutionHostId
  projectRoot: string
}): Promise<MachineStep<ProjectHostSetupResult>> {
  const store = useAppStore.getState()
  const existing = store.projectHostSetups.find(
    (setup) =>
      setup.projectId === args.projectId &&
      setup.hostId === args.hostId &&
      setup.setupState === 'ready'
  )
  const project = store.projects.find((candidate) => candidate.id === args.projectId)
  const existingRepo = existing
    ? store.repos.find((repo) => repo.id === existing.repoId)
    : undefined
  if (existing && existingRepo && project) {
    return { ok: true, value: { project, setup: existing, repo: existingRepo } }
  }
  const url = resolveProjectCloneUrlPrefill(store.projects, store.repos, args.projectId)
  if (!url) {
    return {
      ok: false,
      error: translate(
        'auto.lib.machineWorktreeCreation.noCloneUrl',
        'This project has no remote to clone onto the machine.'
      )
    }
  }
  const failure: { cause?: string } = {}
  const cloned = await store.setupProjectClone(
    {
      projectId: args.projectId,
      hostId: args.hostId,
      url,
      destination: args.projectRoot,
      ...(project ? { displayName: project.displayName } : {})
    },
    { onError: (message) => (failure.cause = message) }
  )
  return cloned
    ? { ok: true, value: cloned }
    : {
        ok: false,
        error: translate(
          'auto.lib.machineWorktreeCreation.cloneFailed',
          'Couldn’t set up the project on the machine.'
        ),
        ...(failure.cause ? { detail: failure.cause } : {})
      }
}

/** Starts the chosen machine and sets the project up on it before the worktree is created. */
export async function prepareMachineRequest(
  creationId: string,
  request: WorktreeCreationRequest,
  machine: MachineRequest
): Promise<WorktreeCreationRequest | null> {
  // Why: the first stage names its activity only once the machine's state is known.
  useAppStore.getState().updatePendingWorktreeCreation(creationId, {
    phase: 'starting-machine',
    provisioningLog: '',
    machineProgress: undefined
  })
  if (machine.environmentId) {
    return wakePairedMachine(creationId, request, machine, machine.environmentId)
  }
  const operationId = createBrowserUuid()
  const unsubscribe = subscribeMachineProgress(operationId, (chunk) =>
    appendProvisioningLog(creationId, chunk)
  )
  const started = await startMachine(
    { providerKey: machine.providerKey, machineId: machine.machineId },
    {
      name: machine.machineName,
      operationId,
      isCanceled: () => !stillPending(creationId),
      onActivity: (activity) =>
        useAppStore
          .getState()
          .updatePendingWorktreeCreation(creationId, { machineProgress: { activity } })
    }
  ).finally(unsubscribe)
  if (!started) {
    return null
  }
  if (!started.ok) {
    return fail(creationId, started.error, started.detail)
  }
  try {
    // Why: the first connect may have just deployed this server; host badges and setup read it.
    useAppStore.getState().setRuntimeEnvironments(await window.api.runtimeEnvironments.list())
  } catch {
    // A stale catalog only delays host badges; setup re-reads the route.
  }
  if (!stillPending(creationId)) {
    return null
  }
  useAppStore.getState().updatePendingWorktreeCreation(creationId, { phase: 'setting-up-project' })
  const setup = await ensureProjectOnMachine({
    projectId: machine.projectId,
    hostId: started.value.hostId,
    projectRoot: started.value.projectRoot
  })
  if (!setup.ok) {
    return fail(creationId, setup.error, setup.detail)
  }
  if (!stillPending(creationId)) {
    return null
  }
  const prepared: WorktreeCreationRequest = {
    ...request,
    repoId: setup.value.repo.id,
    ...getPortableBaseSelection(request),
    workspaceRunContext: {
      kind: 'workspace-run',
      projectId: setup.value.setup.projectId,
      hostId: started.value.hostId,
      projectHostSetupId: setup.value.setup.id,
      repoId: setup.value.repo.id,
      path: setup.value.repo.path
    }
  }
  useAppStore
    .getState()
    .updatePendingWorktreeCreation(creationId, { phase: 'fetching', request: prepared })
  return prepared
}
