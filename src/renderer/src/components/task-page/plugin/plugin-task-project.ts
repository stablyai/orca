import { translate } from '@/i18n/i18n'
import { findGitProjectForSource } from '@/lib/git-remote-project-match'
import { getComposerEligibleRepos } from '@/lib/new-workspace-composer-repo'
import type { ProjectSourceMatcher } from '@/lib/project-source-match'
import type { PluginTaskStartRecipe } from '../../../../../shared/plugins/plugin-task-source'
import type { Repo } from '../../../../../shared/repo-types'

function normalizeProjectPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '')
}

function isWindowsDrivePath(value: string): boolean {
  return /^[a-z]:\//i.test(value)
}

/** Finds the project for a recipe's folder; local projects win over SSH ones with the same path. */
export function findRepoIdForProjectPath(
  repos: readonly Pick<Repo, 'id' | 'path' | 'connectionId'>[],
  projectPath: string
): string | null {
  const wanted = normalizeProjectPath(projectPath)
  const caseInsensitive = isWindowsDrivePath(wanted)
  const matches = repos.filter((repo) => {
    const candidate = normalizeProjectPath(repo.path)
    return caseInsensitive ? candidate.toLowerCase() === wanted.toLowerCase() : candidate === wanted
  })
  return (matches.find((repo) => !repo.connectionId) ?? matches[0])?.id ?? null
}

/** One matcher per source-control kind; each recognises only its own `projectSource` form. */
const PROJECT_SOURCE_MATCHERS: readonly ProjectSourceMatcher[] = [findGitProjectForSource]

export type PluginTaskProject =
  | { kind: 'found'; repoId: string }
  /** The recipe names no project; the composer keeps its usual default. */
  | { kind: 'unspecified' }
  | { kind: 'missing'; message: string }

/** The project a start recipe runs in. Never falls back to an unrelated project when it names one. */
export async function resolvePluginTaskProject(
  recipe: PluginTaskStartRecipe,
  repos: readonly Repo[],
  activeRepoId: string | null
): Promise<PluginTaskProject> {
  const eligible = getComposerEligibleRepos(repos)
  if (recipe.projectPath) {
    const repoId = findRepoIdForProjectPath(eligible, recipe.projectPath)
    return repoId
      ? { kind: 'found', repoId }
      : {
          kind: 'missing',
          message: translate(
            'auto.components.TaskPage.pluginTaskProjectMissing',
            'No Orca project is at {{path}}. Add it as a project, then start again.',
            { path: recipe.projectPath }
          )
        }
  }
  for (const match of PROJECT_SOURCE_MATCHERS) {
    const result = await match(eligible, recipe, activeRepoId)
    if (result) {
      return 'repoId' in result
        ? { kind: 'found', repoId: result.repoId }
        : { kind: 'missing', message: result.missing }
    }
  }
  return { kind: 'unspecified' }
}
