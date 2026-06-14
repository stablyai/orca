import { useMemo } from 'react'
import { getProjectHostSetupForRepo } from '../../../../shared/project-host-setup-projection'
import type { ProjectHostSetup, Repo } from '../../../../shared/types'
import type { SetupScriptPromptInspection } from '@/lib/setup-script-prompt'

export type SetupScriptPromptState = SetupScriptPromptInspection

export type LastVisibleSetupScriptPrompt = {
  state: SetupScriptPromptState
  projectId: string | null
}

export function getRepoProjectId(
  repoId: string,
  repos: readonly Repo[],
  projectHostSetups: readonly ProjectHostSetup[],
  setupByRepoId: Map<string, { projectId: string }>
): string | null {
  const setup = setupByRepoId.get(repoId)
  if (setup) {
    return setup.projectId
  }
  const repo = repos.find((candidate) => candidate.id === repoId)
  return repo ? getProjectHostSetupForRepo(projectHostSetups, repo).projectId : null
}

export function getRenderedSetupScriptPromptState(input: {
  promptState: SetupScriptPromptState | null
  activeRepoId: string
  activeProjectId: string | null
  lastVisiblePrompt: LastVisibleSetupScriptPrompt | null
}): SetupScriptPromptState | null {
  const { activeProjectId, activeRepoId, lastVisiblePrompt, promptState } = input
  if (promptState?.repoId === activeRepoId) {
    return promptState
  }
  return !promptState && lastVisiblePrompt?.projectId === activeProjectId
    ? lastVisiblePrompt.state
    : null
}

export function useSetupScriptPromptProjectContext(
  activeRepo: Repo | null,
  repos: readonly Repo[],
  projectHostSetups: readonly ProjectHostSetup[]
): {
  activeProjectId: string | null
  setupByRepoId: Map<string, { projectId: string }>
} {
  const setupByRepoId = useMemo(
    () => new Map(projectHostSetups.map((setup) => [setup.repoId, setup])),
    [projectHostSetups]
  )
  const activeProjectId = useMemo(() => {
    if (!activeRepo) {
      return null
    }
    return getRepoProjectId(activeRepo.id, repos, projectHostSetups, setupByRepoId)
  }, [activeRepo, projectHostSetups, repos, setupByRepoId])
  return { activeProjectId, setupByRepoId }
}
