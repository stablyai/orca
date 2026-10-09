import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { SetupScriptPromptInspection } from '@/lib/setup-script-prompt'
import { findRepoForHost } from '@/store/slices/repo-host-identity'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'

export type SetupScriptPromptState = SetupScriptPromptInspection & {
  repoHostIdentity: string
}

export type LastVisibleSetupScriptPrompt = {
  state: SetupScriptPromptState
}

export function findSetupScriptPromptRepo(input: {
  repos: readonly Repo[]
  activeRepoId: string | null
  activeWorktree: Pick<Worktree, 'hostId' | 'repoId' | 'runtimeOwnerEnvironmentId'> | null
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null
}): Repo | null {
  const { activeRepoId, activeWorktree, repos, settings } = input
  if (!activeRepoId) {
    return null
  }
  const matchingWorktree = activeWorktree?.repoId === activeRepoId ? activeWorktree : null
  const runtimeOwnerEnvironmentId = matchingWorktree?.runtimeOwnerEnvironmentId?.trim()
  const publisherHostId = runtimeOwnerEnvironmentId
    ? toRuntimeExecutionHostId(runtimeOwnerEnvironmentId)
    : undefined
  const activeWorktreeHostId = publisherHostId ?? matchingWorktree?.hostId
  const rawHostId =
    matchingWorktree?.hostId !== publisherHostId ? matchingWorktree?.hostId : undefined
  return findRepoForHost(repos, activeRepoId, {
    settings,
    ...(rawHostId ? { authoritativeExecutionHostId: rawHostId } : {}),
    ...(publisherHostId ? { catalogOwnerHostId: publisherHostId } : {}),
    ...(activeWorktreeHostId ? { hostId: activeWorktreeHostId } : {})
  })
}

export function markSetupScriptPromptSaved(
  current: SetupScriptPromptState | null,
  savedRepoHostIdentity: string
): SetupScriptPromptState | null {
  return current?.repoHostIdentity === savedRepoHostIdentity && current.status === 'ok'
    ? { ...current, hasEffectiveSetup: true }
    : current
}

export function getRenderedSetupScriptPromptState(input: {
  promptState: SetupScriptPromptState | null
  activeRepoId: string
  activeRepoHostIdentity: string
  lastVisiblePrompt: LastVisibleSetupScriptPrompt | null
}): SetupScriptPromptState | null {
  const { activeRepoHostIdentity, activeRepoId, lastVisiblePrompt, promptState } = input
  if (
    promptState?.repoId === activeRepoId &&
    promptState.repoHostIdentity === activeRepoHostIdentity
  ) {
    return promptState
  }
  return !promptState && lastVisiblePrompt?.state.repoHostIdentity === activeRepoHostIdentity
    ? lastVisiblePrompt.state
    : null
}
