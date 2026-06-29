import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { prepareEphemeralVmWorkspaceTarget } from '@/lib/ephemeral-vm-workspace-target'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import type { Repo } from '../../../shared/types'

const MAX_PROVISIONING_LOG_CHARS = 12_000

export async function prepareRequestForCreate(
  creationId: string,
  request: WorktreeCreationRequest
): Promise<WorktreeCreationRequest | null> {
  if (!request.ephemeralVmRecipe || request.ephemeralVmRuntimeId) {
    return request
  }
  const store = useAppStore.getState()
  store.updatePendingWorktreeCreation(creationId, {
    phase: 'provisioning-vm',
    provisioningLog: ''
  })
  const unsubscribeProvisionEvents = window.api.ephemeralVm.onProvisionEvent?.((event) => {
    if (event.provisionId !== creationId || event.stream !== 'stderr') {
      return
    }
    appendProvisioningLog(creationId, event.chunk)
  })
  let preparedTarget: Awaited<ReturnType<typeof prepareEphemeralVmWorkspaceTarget>>
  try {
    const sourceRepo = store.repos.find(
      (repo) => repo.id === request.ephemeralVmRecipe?.sourceRepoId
    )
    preparedTarget = await prepareEphemeralVmWorkspaceTarget({
      repoId: request.ephemeralVmRecipe.sourceRepoId,
      recipeId: request.ephemeralVmRecipe.recipeId,
      projectId:
        resolvePortableEphemeralVmProjectId(sourceRepo) ?? request.ephemeralVmRecipe.projectId,
      workspaceName: request.name,
      provisionId: creationId,
      setupExistingFolder: store.setupProjectExistingFolder
    })
  } finally {
    unsubscribeProvisionEvents?.()
  }
  if (!preparedTarget.ok) {
    if (!useAppStore.getState().pendingWorktreeCreations[creationId]) {
      return null
    }
    useAppStore.getState().updatePendingWorktreeCreation(creationId, {
      status: 'error',
      error: preparedTarget.error
    })
    if (useAppStore.getState().activePendingCreationId !== creationId) {
      toast.error(preparedTarget.error)
    }
    return null
  }
  appendProvisioningWarnings(creationId, preparedTarget.warnings)
  const preparedRequest: WorktreeCreationRequest = {
    ...request,
    repoId: preparedTarget.setup.repo.id,
    ...getEphemeralVmPortableBaseSelection(request),
    ephemeralVmRuntimeId: preparedTarget.runtimeId,
    ...(preparedTarget.environmentId
      ? { ephemeralVmRuntimeEnvironmentId: preparedTarget.environmentId }
      : {}),
    workspaceRunContext: {
      kind: 'workspace-run',
      projectId: preparedTarget.setup.setup.projectId,
      hostId: preparedTarget.setup.setup.hostId,
      projectHostSetupId: preparedTarget.setup.setup.id,
      repoId: preparedTarget.setup.repo.id,
      path: preparedTarget.setup.repo.path
    }
  }
  if (!useAppStore.getState().pendingWorktreeCreations[creationId]) {
    await cleanupEphemeralVmRuntimeForFailedCreate(preparedRequest)
    return null
  }
  useAppStore.getState().updatePendingWorktreeCreation(creationId, {
    phase: 'fetching',
    request: preparedRequest
  })
  return preparedRequest
}

function getEphemeralVmPortableBaseSelection(
  request: WorktreeCreationRequest
): Pick<WorktreeCreationRequest, 'baseBranch' | 'compareBaseRef'> {
  const keepBaseBranch =
    request.linkedPR !== undefined ||
    request.linkedGitLabMR !== undefined ||
    request.linkedBitbucketPR !== undefined ||
    request.linkedAzureDevOpsPR !== undefined ||
    request.linkedGiteaPR !== undefined ||
    Boolean(request.compareBaseRef) ||
    Boolean(request.pushTarget) ||
    Boolean(request.branchNameOverride)
  if (keepBaseBranch) {
    return {
      ...(request.baseBranch ? { baseBranch: request.baseBranch } : {}),
      ...(request.compareBaseRef ? { compareBaseRef: request.compareBaseRef } : {})
    }
  }
  // Why: VM recipes switch from the source checkout to a freshly provisioned
  // checkout. Source-repo default/pinned local branches may not exist there, so
  // let the remote repo resolve its own default unless the user selected a
  // provider-backed start point above.
  return { baseBranch: undefined, compareBaseRef: undefined }
}

function appendProvisioningWarnings(
  creationId: string,
  warnings: readonly { message: string; remediation?: string }[]
): void {
  if (warnings.length === 0) {
    return
  }
  const text = warnings
    .map((warning) =>
      warning.remediation
        ? `Warning: ${warning.message}\n${warning.remediation}\n`
        : `Warning: ${warning.message}\n`
    )
    .join('')
  appendProvisioningLog(creationId, text)
}

function appendProvisioningLog(creationId: string, chunk: string): void {
  const store = useAppStore.getState()
  const entry = store.pendingWorktreeCreations[creationId]
  if (!entry) {
    return
  }
  // Why: recipe stdout contains the structured result with pairing credentials;
  // only stderr is displayed, and the in-memory tail is bounded.
  const nextLog = `${entry.provisioningLog ?? ''}${chunk}`.slice(-MAX_PROVISIONING_LOG_CHARS)
  store.updatePendingWorktreeCreation(creationId, { provisioningLog: nextLog })
}

export async function attachEphemeralVmRuntimeToWorkspace(
  request: WorktreeCreationRequest,
  workspaceId: string
): Promise<void> {
  if (!request.ephemeralVmRuntimeId) {
    return
  }
  try {
    await window.api.ephemeralVm.attachWorkspace({
      runtimeId: request.ephemeralVmRuntimeId,
      workspaceId
    })
    if (request.ephemeralVmRuntimeEnvironmentId) {
      void useAppStore
        .getState()
        .refreshRuntimeEnvironmentStatus(request.ephemeralVmRuntimeEnvironmentId)
    }
  } catch (error) {
    console.error('Failed to attach ephemeral VM runtime to workspace:', error)
  }
}

function resolvePortableEphemeralVmProjectId(repo: Repo | undefined): string | null {
  const identity = resolveGitHubIdentity(repo)
  if (!identity) {
    return null
  }
  return `github:${identity.owner.toLowerCase()}/${identity.repo.toLowerCase()}`
}

function resolveGitHubIdentity(repo: Repo | undefined): { owner: string; repo: string } | null {
  const upstreamOwner = repo?.upstream?.owner?.trim()
  const upstreamRepo = repo?.upstream?.repo?.trim()
  if (upstreamOwner && upstreamRepo) {
    return { owner: upstreamOwner, repo: upstreamRepo }
  }
  if (repo?.repoIcon?.type === 'image' && repo.repoIcon.source === 'github') {
    const [owner, name, ...rest] = (repo.repoIcon.label ?? '').split('/')
    if (owner?.trim() && name?.trim() && rest.length === 0) {
      return { owner: owner.trim(), repo: name.trim() }
    }
  }
  const remoteIdentity = readGitRemoteIdentity(repo)
  if (remoteIdentity?.canonicalKey?.startsWith('github.com/')) {
    const [, owner, name, ...rest] = remoteIdentity.canonicalKey.split('/')
    if (owner?.trim() && name?.trim() && rest.length === 0) {
      return { owner: owner.trim(), repo: name.trim() }
    }
  }
  const remoteUrlIdentity = parseGitHubRemoteUrl(remoteIdentity?.remoteUrl)
  return remoteUrlIdentity
}

function readGitRemoteIdentity(
  repo: Repo | undefined
): { canonicalKey?: string; remoteUrl?: string } | null {
  const value = (repo as unknown as { gitRemoteIdentity?: unknown } | undefined)?.gitRemoteIdentity
  if (!value || typeof value !== 'object') {
    return null
  }
  const identity = value as { canonicalKey?: unknown; remoteUrl?: unknown }
  return {
    ...(typeof identity.canonicalKey === 'string' ? { canonicalKey: identity.canonicalKey } : {}),
    ...(typeof identity.remoteUrl === 'string' ? { remoteUrl: identity.remoteUrl } : {})
  }
}

function parseGitHubRemoteUrl(
  remoteUrl: string | undefined
): { owner: string; repo: string } | null {
  const trimmed = remoteUrl?.trim()
  if (!trimmed) {
    return null
  }
  const match =
    trimmed.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i) ??
    trimmed.match(/^https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/i)
  if (!match?.[1] || !match[2]) {
    return null
  }
  return { owner: match[1], repo: match[2] }
}

export async function cleanupEphemeralVmRuntimeForFailedCreate(
  request: WorktreeCreationRequest
): Promise<void> {
  if (!request.ephemeralVmRuntimeId) {
    return
  }
  try {
    await window.api.ephemeralVm.cleanup({ runtimeId: request.ephemeralVmRuntimeId })
  } catch (error) {
    console.error('Failed to clean up ephemeral VM runtime after workspace creation failed:', error)
  }
}
