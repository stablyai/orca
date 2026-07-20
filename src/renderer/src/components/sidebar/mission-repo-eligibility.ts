import { getRendererAppPlatform } from '@/lib/renderer-app-platform'
import { isMissionEligibleRepo } from '../../../../shared/missions'
import { resolveProjectExecutionRuntime } from '../../../../shared/project-execution-runtime'
import type { GlobalSettings, Project, Repo } from '../../../../shared/types'

export type MissionRepoEligibilityContext = {
  projects: readonly Project[]
  settings: Pick<GlobalSettings, 'localWindowsRuntimeDefault'> | null | undefined
  appPlatform?: NodeJS.Platform
}

/** Mirrors the main-process Mission gate so Windows projects assigned to WSL
 * are hidden before an IPC request that main must reject. */
export function isRendererMissionEligibleRepo(
  repo: Repo,
  context: MissionRepoEligibilityContext
): boolean {
  if (!isMissionEligibleRepo(repo)) {
    return false
  }

  const appPlatform = context.appPlatform ?? getRendererAppPlatform()
  if (appPlatform !== 'win32') {
    return true
  }

  const project = context.projects.find((entry) => entry.sourceRepoIds.includes(repo.id))
  if (!project) {
    return true
  }

  const resolution = resolveProjectExecutionRuntime({
    appPlatform,
    projectId: project.id,
    projectRuntimePreference: project.localWindowsRuntimePreference,
    globalWindowsRuntimeDefault: context.settings?.localWindowsRuntimeDefault
  })
  return resolution.status === 'resolved' && resolution.runtime.kind !== 'wsl'
}
