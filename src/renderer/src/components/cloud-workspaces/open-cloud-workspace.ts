// Opening a cloud workspace from the team list or a link. The owner already has it locally (the
// hosted runtime they created); anyone else pairs this device through a per-device E2EE grant and
// the workspace's server joins the sidebar like any remote Orca server.
import { hasLocalSidebarRow } from './cloud-local-row'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import { activateAndRevealWorktree } from '@/lib/workspace/activation/worktree-activation'
import { refreshRuntimeProjectWorktreesAndLineage } from '@/hooks/runtime-project-refresh-scheduler'
import { RuntimeRpcCallError, unwrapRuntimeRpcResult } from '@/runtime/rpc/calls/runtime-rpc-result'
import type { CloudWorkspace } from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'
import {
  getWorktreeExecutionHostId,
  toRuntimeExecutionHostId
} from '../../../../shared/execution-host'
import { refreshCloudMessageSenders } from '@/lib/cloud-message-sender'
import { describeError, isUnknownServerFailure } from './cloud-workspace-errors'

/** On success, the worktree that was revealed (null when its projects are still syncing). */
export type OpenOutcome =
  | { ok: true; worktreeId: string | null; hostId?: string }
  /** `unknownServerError`: the wake failed on the server for no known reason (shared copy). */
  | { ok: false; message: string; unknownServerError?: boolean }

// Rejections that mean this device's pairing is no longer accepted (revoked grant, rebuilt VM).
const PAIRING_REJECTED_CODES = new Set(['unauthorized', 'device_revoked', 'forbidden'])

export function cloudWorkspaceTitle(
  w: Pick<CloudWorkspace, 'title' | 'repo' | 'workspaceId'>,
  t: Translate = translate
): string {
  if (w.title) {
    return w.title
  }
  const repoName = w.repo?.url
    .replace(/\/+$/, '')
    .split('/')
    .at(-1)
    ?.replace(/\.git$/, '')
  return w.repo?.branch
    ? `${repoName ?? t('auto.components.cloudWorkspaces.workspaceFallback', 'workspace')} · ${w.repo.branch}`
    : (repoName ?? w.workspaceId)
}

export function firstWorktreeOnHost(hostId: string): string | null {
  const state = useAppStore.getState()
  for (const [repoId, worktrees] of Object.entries(selectWorktreesByRepo(state))) {
    const repo = state.repos.find((r) => r.id === repoId)
    for (const worktree of worktrees) {
      if (getWorktreeExecutionHostId(worktree, repo) === hostId) {
        return worktree.id
      }
    }
  }
  return null
}

function isPairingRejected(error: unknown): boolean {
  if (error instanceof RuntimeRpcCallError) {
    return PAIRING_REJECTED_CODES.has(error.code)
  }
  return error instanceof Error && /\b(unauthori[sz]ed|device_revoked)\b/i.test(error.message)
}

export type OpenCloudWorkspaceOptions = {
  /**
   * The server this open connects to, before any of its rows load. A GitHub-only create's sheet
   * hides that server's rows until it hands off to them, so its pending row never doubles up.
   */
  onHost?: (hostId: string) => void
}

async function connectAndReveal(
  environmentId: string,
  name: string,
  options: OpenCloudWorkspaceOptions = {}
): Promise<OpenOutcome> {
  options.onHost?.(toRuntimeExecutionHostId(environmentId))
  const environments = await window.api.runtimeEnvironments.list()
  useAppStore.getState().setRuntimeEnvironments(environments)
  const environment = environments.find((e) => e.id === environmentId)
  if (!environment) {
    return {
      ok: false,
      message: translate(
        'auto.components.cloudWorkspaces.serverNotSaved',
        "Couldn't add the workspace to this computer. Your files are safe. Try again."
      )
    }
  }
  const response = await window.api.runtimeEnvironments.connect({
    selector: environment.id,
    timeoutMs: 20_000
  })
  unwrapRuntimeRpcResult(response)
  const store = useAppStore.getState()
  await store.readRuntimeHostStatusSnapshots()
  const repos = await store.fetchRuntimeEnvironmentRepos(environment.id)
  await refreshRuntimeProjectWorktreesAndLineage(
    environment.id,
    repos,
    (repoId, options) => useAppStore.getState().fetchWorktrees(repoId, options),
    (options) => useAppStore.getState().fetchWorktreeLineage(options)
  )
  const hostId = toRuntimeExecutionHostId(environment.id)
  const worktreeId = firstWorktreeOnHost(hostId)
  if (worktreeId) {
    activateAndRevealWorktree(worktreeId, { executionHostId: hostId })
  } else {
    toast.success(
      translate(
        'auto.components.cloudWorkspaces.connected',
        '{{value0}} is connected. Its projects are in the sidebar.',
        { value0: name }
      )
    )
  }
  return { ok: true, worktreeId, hostId }
}

/** Drops this device's previous pairing so re-pairing does not leave a dead server and grant. */
async function forgetPairing(
  workspaceId: string,
  binding: { environmentId: string; grantId: string | null },
  environmentStillSaved: boolean
): Promise<void> {
  if (environmentStillSaved) {
    await window.api.runtimeEnvironments
      .remove({ selector: binding.environmentId })
      .catch(() => undefined)
  }
  if (binding.grantId) {
    await window.api.cloudWorkspaces
      .revokeGrant(workspaceId, binding.grantId)
      .catch(() => undefined)
  }
}

/** Wakes a sleeping workspace before connecting to it; the failed outcome when it was refused. */
async function wakeIfAsleep(workspace: CloudWorkspace): Promise<OpenOutcome | null> {
  if (workspace.status !== 'suspended' && workspace.status !== 'suspending') {
    return null
  }
  const woke = await window.api.cloudWorkspaces.wake(workspace.id)
  if (woke.ok) {
    return null
  }
  const owner = {
    self: workspace.access === 'owner',
    name: workspace.memberNames?.[workspace.ownerUserId] ?? null
  }
  return {
    ok: false,
    message: describeError(woke.error, woke.reason, translate, owner),
    unknownServerError: isUnknownServerFailure(woke.error, woke.status)
  }
}

async function pairAndReveal(
  workspace: CloudWorkspace,
  name: string,
  options: OpenCloudWorkspaceOptions
): Promise<OpenOutcome> {
  const api = window.api.cloudWorkspaces
  const binding = (await api.environmentBindings())[workspace.id]
  if (binding) {
    const environments = await window.api.runtimeEnvironments.list()
    const saved = environments.some((e) => e.id === binding.environmentId)
    if (saved) {
      // PAIRED-WAKE: an existing pairing connects straight to the VM, which a sleeping one can't
      // answer; wake it first (billing refusals read like a teammate's grant refusal below).
      const refused = await wakeIfAsleep(workspace)
      if (refused) {
        return refused
      }
      try {
        return await connectAndReveal(binding.environmentId, name, options)
      } catch (error) {
        // Only a rejected pairing is fixed by pairing again; anything else is surfaced as is.
        if (!isPairingRejected(error)) {
          throw error
        }
      }
    }
    await forgetPairing(workspace.id, binding, saved)
  }
  const grant = await api.openGrant(workspace.id)
  if (!grant.ok) {
    // Waking counts against the owner's seat, so a teammate is told whose sandboxes to put to sleep.
    const owner = {
      self: workspace.access === 'owner',
      name: workspace.memberNames?.[workspace.ownerUserId] ?? null
    }
    return {
      ok: false,
      message: describeError(grant.error, grant.reason, translate, owner),
      unknownServerError: isUnknownServerFailure(grant.error, grant.status)
    }
  }
  const added = await window.api.runtimeEnvironments.verifyAndAddFromPairingCode({
    name: translate('auto.components.cloudWorkspaces.environmentName', '{{value0}} (cloud)', {
      value0: name
    }).slice(0, 120),
    pairingCode: grant.value.pairingCode
  })
  if (!added.ok) {
    await api.revokeGrant(workspace.id, grant.value.grantId).catch(() => undefined)
    return {
      ok: false,
      message: translate(
        'auto.components.cloudWorkspaces.verifyFailed',
        "Couldn't connect this computer to the workspace. Your files are safe. Try again."
      )
    }
  }
  try {
    await api.bindEnvironment(workspace.id, added.environment.id, grant.value.grantId)
  } catch (error) {
    // Unbound, the next open could not find or clean up this pairing; undo it now instead.
    await forgetPairing(
      workspace.id,
      { environmentId: added.environment.id, grantId: grant.value.grantId },
      true
    )
    throw error
  }
  // Messages to this workspace now carry the sender line if it is shared with the team.
  void refreshCloudMessageSenders().catch(() => undefined)
  return await connectAndReveal(added.environment.id, name, options)
}

async function openOnce(
  workspace: CloudWorkspace,
  options: OpenCloudWorkspaceOptions
): Promise<OpenOutcome> {
  const name = cloudWorkspaceTitle(workspace)
  try {
    if (workspace.access === 'owner') {
      const local = (await window.api.cloudWorkspaces.localWorkspaces()).find(
        (l) => l.sandboxId === workspace.id
      )
      // Only with this window's row: a record alone (after a re-sign-in) would reveal nothing (REG-8b).
      if (local && hasLocalSidebarRow(local)) {
        activateAndRevealWorktree(
          local.worktreeId,
          local.runtimeEnvironmentId
            ? { executionHostId: toRuntimeExecutionHostId(local.runtimeEnvironmentId) }
            : undefined
        )
        return { ok: true, worktreeId: local.worktreeId }
      }
      // Owned but created on another device (or reassigned to me): pair this device like a teammate.
    }
    if (workspace.access === 'none') {
      return {
        ok: false,
        message: translate(
          'auto.components.cloudWorkspaces.noAccess',
          "You don't have access to this workspace. Ask its owner to share it with the team."
        )
      }
    }
    return await pairAndReveal(workspace, name, options)
  } catch (error) {
    // Raw transport/RPC messages are not user copy; keep them for diagnostics only.
    console.warn('[cloud-workspaces] open failed', error)
    return {
      ok: false,
      message: translate(
        'auto.components.cloudWorkspaces.openFailed',
        "Couldn't open the workspace. Your files are safe. Try again."
      )
    }
  }
}

// One open per workspace at a time: a double click, a link and the menu all share the same attempt
// instead of minting parallel grants.
const opening = new Map<string, Promise<OpenOutcome>>()

export function openCloudWorkspace(
  workspace: CloudWorkspace,
  options: OpenCloudWorkspaceOptions = {}
): Promise<OpenOutcome> {
  const existing = opening.get(workspace.id)
  if (existing) {
    return existing
  }
  const attempt = openOnce(workspace, options).finally(() => opening.delete(workspace.id))
  opening.set(workspace.id, attempt)
  return attempt
}

// Copy link lives beside it; re-exported so callers keep one import.
export { copyCloudWorkspaceLink, shareLinkFor } from './cloud-workspace-share-link'
