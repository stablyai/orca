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
    // Why win32 unconditionally: a non-Windows host cannot produce a drive or WSL UNC repo path, so
    // the boundary check below rejects it regardless of what platform we claim here.
    appPlatform: 'win32',
    projectId: project?.id ?? repo.id,
    projectRuntimePreference: project?.localWindowsRuntimePreference,
    globalWindowsRuntimeDefault: settings.localWindowsRuntimeDefault
  })
  // Why not warn on repair-required: the runtime is unusable, and a perf advisory on top of the
  // repair prompt is noise.
  return resolution.status === 'resolved' && resolution.runtime.kind === 'wsl'
    ? resolution.runtime.distro
    : null
}

/**
 * Advises that a just-added project's working tree sits on the Windows drive while its git runs in
 * WSL, so every command pays the 9p/drvfs crossing.
 *
 * Worktree placement already moves NEW workspaces inside the distro, but the project's own tree
 * stays where the user put it and that cost is otherwise invisible — the project simply feels slow.
 */
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
