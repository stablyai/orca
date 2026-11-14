import { pickerRepos } from '../../../../shared/hidden-projects'
import type { ComposerModel } from './composer-model'

type Repos = ComposerModel['eligibleRepos']

let last: { repos: Repos; chosen: string; list: Repos } | null = null

/** The picker's list without hidden projects, identical across renders while its inputs are. */
export function composerPickerRepos(repos: Repos, chosen: string): Repos {
  if (last?.repos !== repos || last.chosen !== chosen) {
    last = { repos, chosen, list: pickerRepos(repos, chosen) }
  }
  return last.list
}
