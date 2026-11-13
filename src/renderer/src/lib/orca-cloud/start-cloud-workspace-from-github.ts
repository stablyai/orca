// "Start in Orca Cloud" for a repository with no clone here (cloud-start D4): the sandbox clones it
// from GitHub, this computer pairs to it like any cloud workspace, and the composer's prompt goes
// to the chosen agent there. Nothing is written to this computer's disk.
//
// GH-CREATE-SHEET: it shows the same build sheet as an Orca Cloud create from a local clone: Start
// sandbox, Clone repository (git's progress), Open workspace, with the same failure cards, billing
// blocker, Retry and Back to draft. The sheet is a pending creation like any other; this module
// runs it instead of the worktree create.
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { openCloudWorkspace } from '@/components/cloud-workspaces/open-cloud-workspace'
import { refreshCloudWorktreeBindings } from '@/components/cloud-workspaces/cloud-workspace-identity'
import { createNonSecureContextUuid } from '../../../../shared/non-secure-context-uuid'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import { ORCA_CLOUD_RECIPE_ID } from '../../../../shared/hosted-sandbox/orca-cloud-recipe-id'
import type { WorktreeCreationRequest } from '@/lib/workspace/creation/pending-worktree-creation'
import { appendProvisioningLog } from '@/lib/workspace/creation/pending-creation-provisioning-log'
import { setOrcaCloudCancelRetry, trackOrcaCloudCreateStep } from '@/lib/orca-cloud-cancel-cleanup'
import { CANCEL_CLEANUP_UNCONFIRMED } from '../../../../shared/hosted-sandbox/cloud-workspace-api'
import { launchFirstCloudAgent } from './github-cloud-first-agent'
import {
  forgetGitHubCreateKey,
  githubCreateIdempotencyKey,
  noteGitHubCreateOutcome
} from './github-cloud-create-key'

export type StartFromGitHubRequest = {
  repoUrl: string
  fullName: string
  prompt: string
  agent: string | null
  /** The project the composer had selected, for Back to draft. */
  composerRepoId?: string
}

const NETWORK_FAILURE =
  /\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|network (error|unreachable))\b/i

// Sandboxes a creation already started, so a Retry after a failed open opens it, never makes another.
const startedSandboxes = new Map<string, string>()

/** The pending creation's request: the sheet's title, Orca Cloud copy, Retry and Back to draft. */
export function githubCreateRequest(request: StartFromGitHubRequest): WorktreeCreationRequest {
  const prompt = request.prompt.trim()
  const repoName = request.fullName.split('/').pop() ?? request.fullName
  return {
    repoId: '',
    // The composer's name field is the workspace's name (NAME-DROPPED); the repository's otherwise.
    name: prompt.slice(0, 120) || repoName,
    displayName: prompt.slice(0, 120) || repoName,
    displayNameKind: prompt ? 'user' : 'generated',
    setupDecision: 'inherit',
    agent: isTuiAgent(request.agent) ? request.agent : null,
    pendingFirstAgentMessageRename: false,
    note: '',
    startupPlan: null,
    quickPrompt: request.prompt,
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
      prompt: request.prompt,
      composerRepoId: request.composerRepoId ?? ''
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
  const title = source.prompt.trim().slice(0, 120)
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
    // EP-5: a cancel whose sandbox the control plane didn't confirm deleted is not "Sandbox deleted".
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
  const sandboxId = startedSandboxes.get(creationId) ?? (await startSandbox(creationId))
  if (!sandboxId) {
    return false
  }
  if (!current(creationId)) {
    // GH-CREATE-CANCEL: cancelled after the sandbox started but before it opened.
    await discardSandbox(creationId, sandboxId)
    return false
  }
  useAppStore.getState().updatePendingWorktreeCreation(creationId, { phase: 'creating' })
  const workspace = await window.api.cloudWorkspaces.get(sandboxId).catch(() => null)
  const opened = workspace?.ok
    ? await openCloudWorkspace(workspace.value, {
        // GH-CREATE-NO-ROW: that server's rows wait behind the pending row until the hand-off.
        onHost: (hostId) =>
          useAppStore
            .getState()
            .updatePendingWorktreeCreation(creationId, { pairingHostId: hostId })
      })
    : null
  if (!current(creationId)) {
    // GH-CREATE-CANCEL: cancelled while it opened. Opening can't be stopped half way, so the
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
  // PAIRED-HELD-STRIPS (#568): the chosen agent starts even with no prompt, once the workspace
  // lists its first worktree and is confirmed Orca Cloud (so its launch holds when it can't run).
  void launchFirstCloudAgent({
    fullName: source.fullName,
    prompt: source.prompt,
    agent: request.agent,
    worktreeId: opened.worktreeId,
    hostId: opened.hostId
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
  // EP-5: the cancel's toast waits for this delete and says "deleted" only if it went through.
  const ok = await trackOrcaCloudCreateStep(creationId, destroy(), (deleted) => deleted)
  if (!ok) {
    console.warn('[orca-cloud] cancelled GitHub create: could not delete sandbox', sandboxId)
    setOrcaCloudCancelRetry(creationId, destroy)
  }
  void refreshCloudWorktreeBindings().catch(() => undefined)
}
