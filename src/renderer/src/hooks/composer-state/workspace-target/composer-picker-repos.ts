import {
  pickerRepos,
  projectsHiddenHostsRevision
} from '../../../../../shared/project/catalog/hidden-projects'
import type { ComposerModel } from '../composer-model'

type Repos = ComposerModel['eligibleRepos']

let last: { repos: Repos; chosen: string; revision: number; list: Repos } | null = null

/** The picker's list without hidden projects, identical across renders while its inputs are. */
export function composerPickerRepos(repos: Repos, chosen: string): Repos {
  const revision = projectsHiddenHostsRevision()
  if (last?.repos !== repos || last.chosen !== chosen || last.revision !== revision) {
    last = { repos, chosen, revision, list: pickerRepos(repos, chosen) }
  }
  return last.list
}
