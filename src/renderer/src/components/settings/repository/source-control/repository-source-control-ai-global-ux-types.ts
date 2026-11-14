import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import type {
  RepoSourceControlAiOverrides,
  SourceControlAiSettings
} from '../../../../../../shared/source-control/ai/settings/source-control-ai-settings-types'
import type { SourceControlAiRepoUpdate } from '../../../../../../shared/source-control/ai/settings/source-control-ai-recipe-save'

export type HostedReviewDefaultKey = keyof NonNullable<
  RepoSourceControlAiOverrides['prCreationDefaults']
>

export type UseRepositorySourceControlAiGlobalUxArgs = {
  repoId: string
  persistedRepoAi: RepoSourceControlAiOverrides
  settings: Pick<GlobalSettings, 'sourceControlAi' | 'commitMessageAi' | 'defaultTuiAgent'> | null
  source: SourceControlAiSettings
  updateRepo: (repoId: string, updates: SourceControlAiRepoUpdate) => void | Promise<boolean>
}
