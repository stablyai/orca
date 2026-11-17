// "Start in Orca Cloud" for a repository with no clone here: the sandbox clones it
// from GitHub, this computer pairs to it like any cloud workspace, and the chosen agent starts there
// with no prompt (the composer's name field only names the workspace).
// Nothing is written to this computer's disk.
//
// It shows the same build sheet as an Orca Cloud create from a local clone: Start
// sandbox, Clone repository (git's progress), Open workspace, with the same failure cards, billing
// blocker, Retry and Back to draft. The sheet is a pending creation like any other; this module
// runs it instead of the worktree create.
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { openCloudWorkspace } from '@/components/cloud-workspaces/open-cloud-workspace'
import { refreshCloudWorktreeBindings } from '@/components/cloud-workspaces/cloud-workspace-identity'
import { createNonSecureContextUuid } from '../../../../shared/identifiers/non-secure-context-uuid'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import { ORCA_CLOUD_RECIPE_ID } from '../../../../shared/hosted-sandbox/orca-cloud-recipe-id'
import type { WorktreeCreationRequest } from '@/lib/workspace/creation/pending-worktree-creation'
import { appendProvisioningLog } from '@/lib/workspace/creation/pending-creation-provisioning-log'
import { setOrcaCloudCancelRetry, trackOrcaCloudCreateStep } from '@/lib/orca-cloud-cancel-cleanup'
import { CANCEL_CLEANUP_UNCONFIRMED } from '../../../../shared/hosted-sandbox/cloud-workspace-api'
import { launchFirstCloudAgent } from './github-cloud-first-agent'
import type { CloudFirstAgentLaunch } from './github-create-source'
import {
  beginCloudCreateGitHubAccess,
  gateCloudCreateOnGitHubAccess
} from './cloud-create-github-access'
import { applyCloudGitHubAccessToSandbox } from './cloud-create-github-apply'
import {
  forgetGitHubCreateKey,
  githubCreateIdempotencyKey,
  noteGitHubCreateOutcome
} from './github-cloud-create-key'

type StartFromGitHubRequest = {
  repoUrl: string
  fullName: string
  /** The composer's name field: the workspace's name only, never sent to the agent. */
  name: string
  /** The composer's agent pick; null is Blank terminal (no agent is started). */
  agent: string | null
  /** The project the composer had selected, for Back to draft. */
  composerRepoId?: string
  firstAgent?: CloudFirstAgentLaunch
}

const NETWORK_FAILURE =
  /\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|network (error|unreachable))\b/i

// Sandboxes a creation already started, so a Retry after a failed open opens it, never makes another.
const startedSandboxes = new Map<string, string>()

/** The pending creation's request: the sheet's title, Orca Cloud copy, Retry and Back to draft. */
export function githubCreateRequest(request: StartFromGitHubRequest): WorktreeCreationRequest {
  const name = request.name.trim()
  const repoName = request.fullName.split('/').pop() ?? request.fullName
  return {
    repoId: '',
    // The composer's name field is the workspace's name; the repository's otherwise.
    name: name.slice(0, 120) || repoName,
    displayName: name.slice(0, 120) || repoName,
    displayNameKind: name ? 'user' : 'generated',
    setupDecision: 'inherit',
    agent: isTuiAgent(request.agent) ? request.agent : null,
    pendingFirstAgentMessageRename: false,
    note: '',
    startupPlan: null,
    // The name is not a prompt; this create has none.
    quickPrompt: '',
    quickTelemetry: null,
    telemetrySource: 'unknown',
    ephemeralVmRecipe: {
      sourceRepoId: '',
      recipeId: ORCA_CLOUD_RECIPE_ID,
      projectId: '',
      provider: 'orca-cloud'
    },
    githubSource: {
      repoUrl: request.repoUrl,
      fullName: request.fullName,
      name: request.name,
      composerRepoId: request.composerRepoId ?? '',
      ...(request.firstAgent ? { firstAgent: request.firstAgent } : {})
    }
  }
}

/** Opens the build sheet and starts; resolves true once the workspace is open. */
export function startCloudWorkspaceFromGitHub(request: StartFromGitHubRequest): Promise<boolean> {
  const creationId = createNonSecureContextUuid()
  const store = useAppStore.getState()
  store.beginPendingWorktreeCreation({
    creationId,
    phase: 'provisioning-vm',
    status: 'creating',
    startedAt: Date.now(),
    indeterminate: false,
    loaderVisible: true,
    provisioningLog: '',
    provisioningLogStamps: [],
    request: githubCreateRequest(request)
  })
  store.setActiveView('terminal')
  store.setSidebarOpen(true)
  return runTracked(creationId)
}

/** Cancel's "Deleting the sandbox…" waits for every step that may still own a sandbox. */
function runTracked(creationId: string): Promise<boolean> {
  return trackOrcaCloudCreateStep(creationId, runGitHubCloudCreate(creationId))
}

/** The sheet's Retry (and the plans page's retry after checkout) for a GitHub-only create. */
export function retryGitHubCloudCreate(creationId: string): void {
  const store = useAppStore.getState()
  if (!store.pendingWorktreeCreations[creationId]?.request.githubSource) {
    return
  }
  const opening = startedSandboxes.has(creationId)
  store.updatePendingWorktreeCreation(creationId, {
    status: 'creating',
    loaderVisible: true,
    error: undefined,
    errorCode: undefined,
    // The sandbox is up: only opening it is tried again, so its steps stay done.
    ...(opening
      ? { phase: 'creating' }
      : {
          startedAt: Date.now(),
          phase: 'provisioning-vm',
          provisioningLog: '',
          provisioningLogStamps: []
        })
  })
  store.setActivePendingWorktreeCreation(creationId)
  store.setActiveView('terminal')
  void runTracked(creationId)
}

function current(creationId: string) {
  return useAppStore.getState().pendingWorktreeCreations[creationId]
}

function fail(creationId: string, error: string, errorCode?: string | null): false {
  if (current(creationId)) {
    useAppStore.getState().updatePendingWorktreeCreation(creationId, {
      status: 'error',
      error,
      errorCode: errorCode ?? undefined
    })
  }
  return false
}

async function startSandbox(creationId: string): Promise<string | null> {
  const source = current(creationId)?.request.githubSource
  if (!source) {
    return null
  }
  const unsubscribe = window.api.ephemeralVm.onProvisionEvent?.((event) => {
    if (event.provisionId === creationId && event.stream === 'stderr') {
      appendProvisioningLog(creationId, event.chunk)
    }
  })
  const title = source.name.trim().slice(0, 120)
  const created = await trackOrcaCloudCreateStep(
    creationId,
    window.api.orcaCloudWorkspace
      .createFromGitHub({
        repoUrl: source.repoUrl,
        ...(title ? { title } : {}),
        provisionId: creationId,
        idempotencyKey: githubCreateIdempotencyKey(creationId)
      })
      .catch(() => null),
    // A cancel whose sandbox the control plane didn't confirm deleted is not "Sandbox deleted".
    (result) => result?.ok !== false || result.reason !== CANCEL_CLEANUP_UNCONFIRMED
  ).finally(() => unsubscribe?.())
  if (created && !created.ok && created.reason === CANCEL_CLEANUP_UNCONFIRMED) {
    setOrcaCloudCancelRetry(creationId, () =>
      window.api.orcaCloudWorkspace.retryCancelledCreate({ provisionId: creationId })
    )
  }
  noteGitHubCreateOutcome(
    creationId,
    !created ||
      (!created.ok && (created.code === 'unavailable' || NETWORK_FAILURE.test(created.message)))
  )
  if (!created?.ok) {
    fail(
      creationId,
      created?.message ??
        translate(
          'components.newWorkspace.cloudOnly.startFailed',
          'Couldn’t start the cloud workspace. Nothing was created, and you weren’t charged.'
        ),
      created?.reason
    )
    return null
  }
  startedSandboxes.set(creationId, created.value.sandboxId)
  return created.value.sandboxId
}

async function runGitHubCloudCreate(creationId: string): Promise<boolean> {
  const request = current(creationId)?.request
  const source = request?.githubSource
  if (!request || !source) {
    return false
  }
  if (!startedSandboxes.has(creationId)) {
    // The GitHub access step: asked alongside Start sandbox, so it adds nothing when access is fine.
    beginCloudCreateGitHubAccess(creationId, source.repoUrl)
  }
  const sandboxId = startedSandboxes.get(creationId) ?? (await startSandbox(creationId))
  if (!sandboxId) {
    return false
  }
  // Held before Open workspace while the GitHub step asks for access.
  const github = await gateCloudCreateOnGitHubAccess(creationId)
  if (!current(creationId) || !github.proceed) {
    // Cancelled after the sandbox started but before it opened.
    await discardSandbox(creationId, sandboxId)
    return false
  }
  if (github.grantedDuringCreate) {
    // Granted after the sandbox started: its git gets the token now, not after a restart.
    await applyCloudGitHubAccessToSandbox({ sandboxId })
  }
  useAppStore.getState().updatePendingWorktreeCreation(creationId, { phase: 'creating' })
  const workspace = await window.api.cloudWorkspaces.get(sandboxId).catch(() => null)
  const opened = workspace?.ok
    ? await openCloudWorkspace(workspace.value, {
        // Its pending row shows the open's progress and failure (no open toasts).
        feedback: false,
        // That server's rows wait behind the pending row until the hand-off.
        onHost: (hostId) =>
          useAppStore
            .getState()
            .updatePendingWorktreeCreation(creationId, { pairingHostId: hostId })
      })
    : null
  if (!current(creationId)) {
    // Cancelled while it opened. Opening can't be stopped half way, so the
    // sandbox is deleted, which also drops this computer's pairing and its row.
    await discardSandbox(creationId, sandboxId)
    return false
  }
  if (!opened?.ok) {
    // The sandbox exists from here on: Retry opens it and never creates it again.
    return fail(
      creationId,
      opened?.message ??
        translate(
          'components.newWorkspace.cloudOnly.openLater2',
          'Your cloud workspace started, but this computer couldn’t open it yet. Try again, or open it later from Open cloud workspace…'
        )
    )
  }
  startedSandboxes.delete(creationId)
  forgetGitHubCreateKey(creationId)
  // Opened: the workspace replaces the sheet. Nothing to clean up, the sandbox is the workspace.
  useAppStore.getState().removePendingWorktreeCreation(creationId, { cleanupVm: false })
  // The workspace gets its own branch once the clone is listed; the chosen agent then starts there
  // even with no prompt, once confirmed Orca Cloud (so its launch holds when it can't run).
  // Blank terminal (no agent) starts nothing.
  void launchFirstCloudAgent({
    fullName: source.fullName,
    agent: request.agent,
    launch: source.firstAgent,
    name: request.name,
    worktreeId: opened.worktreeId,
    hostId: opened.hostId,
    sandboxId
  })
  return true
}

/** A cancelled create's sandbox: deleted, so nothing keeps running (or billing) behind the cancel. */
async function discardSandbox(creationId: string, sandboxId: string): Promise<void> {
  startedSandboxes.delete(creationId)
  forgetGitHubCreateKey(creationId)
  const destroy = (): Promise<boolean> =>
    window.api.cloudWorkspaces
      .destroy(sandboxId)
      .then((result) => result.ok)
      .catch(() => false)
  // The cancel's toast waits for this delete and says "deleted" only if it went through.
  const ok = await trackOrcaCloudCreateStep(creationId, destroy(), (deleted) => deleted)
  if (!ok) {
    console.warn('[orca-cloud] cancelled GitHub create: could not delete sandbox', sandboxId)
    setOrcaCloudCancelRetry(creationId, destroy)
  }
  void refreshCloudWorktreeBindings().catch(() => undefined)
}
