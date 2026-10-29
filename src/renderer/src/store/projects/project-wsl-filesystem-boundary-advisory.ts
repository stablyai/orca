import { toast } from 'sonner'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { Project } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { getWslFilesystemBoundaryDistro } from '../../../../shared/wsl-paths'
import { resolveProjectExecutionRuntime } from '../../../../shared/project-execution-runtime'
import { translate } from '@/i18n/i18n'

type BoundaryAdvisorySettings = Pick<GlobalSettings, 'localWindowsRuntimeDefault'>

/** The distro this project's git runs in, or null when it runs on the Windows host or elsewhere. */
function getProjectWslRuntimeDistro(
  repo: Repo,
  projects: readonly Project[],
  settings: BoundaryAdvisorySettings
): string | null {
  const project = projects.find((candidate) => candidate.sourceRepoIds.includes(repo.id))
  const resolution = resolveProjectExecutionRuntime({
    // Non-Windows hosts cannot produce drive/WSL UNC repo paths; boundary detection rejects them even with win32 here.
    appPlatform: 'win32',
    projectId: project?.id ?? repo.id,
    projectRuntimePreference: project?.localWindowsRuntimePreference,
    globalWindowsRuntimeDefault: settings.localWindowsRuntimeDefault
  })
  // Unusable runtimes already need repair; avoid stacking a performance advisory on that prompt.
  return resolution.status === 'resolved' && resolution.runtime.kind === 'wsl'
    ? resolution.runtime.distro
    : null
}

/** Warn when project tree stays on Windows drive while git runs in WSL, paying 9p/drvfs per command. Worktree placement fixes new workspaces, not the original tree. */
export function warnIfProjectCrossesWslFilesystemBoundary(
  repo: Repo,
  projects: readonly Project[],
  settings: BoundaryAdvisorySettings | null
): void {
  try {
    if (!settings || getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID) {
      return
    }
    const distro = getWslFilesystemBoundaryDistro({
      projectPath: repo.path,
      wslRuntimeDistro: getProjectWslRuntimeDistro(repo, projects, settings)
    })
    if (!distro) {
      return
    }
    toast.warning(
      translate(
        'auto.store.slices.repos.wslFilesystemBoundaryTitle',
        'This project is stored on a Windows drive'
      ),
      {
        description: translate(
          'auto.store.slices.repos.wslFilesystemBoundaryDescription',
          'Git for this project runs in {{distro}}, which reaches Windows drives over the WSL filesystem bridge. Expect git to be roughly 20x slower than it would be on a copy stored inside {{distro}}.',
          { distro }
        )
      }
    )
  } catch (err) {
    // Why: adding a project should not fail because a performance advisory could not be computed.
    console.warn('Failed to check WSL filesystem boundary for added project:', err)
  }
}
