import type { AppState } from '@/store'
import type {
  RuntimeGeneratePullRequestFieldsOverrides,
  RuntimeGitContext
} from '@/runtime/runtime-git-client'
import type { Repo } from '../../../../shared/repo-types'
import type { HostedReviewCreationEligibility } from '../../../../shared/hosted-review'
import type { SourceControlAiPrCreationDefaults } from '../../../../shared/source-control-ai-types'
import type { PullRequestFieldRevisions } from '@/store/slices/pull-request-generation'

export type PullRequestDraftFields = {
  base: string
  title: string
  body: string
  draft: boolean
}

export type UseCreatePullRequestDialogFieldsOptions = {
  open: boolean
  repoId: string
  worktreeId: string | null
  worktreePath: string
  branch: string
  eligibility: HostedReviewCreationEligibility | null
  currentBaseRef?: string | null
  repo?: Pick<Repo, 'sourceControlAi'> | null
  settings: AppState['settings']
  submitting: boolean
  prCreationDefaults?: SourceControlAiPrCreationDefaults
  sourceControlAiActionsVisible?: boolean
  // When the composer is hidden by a temporary policy (a hard refresh error) for
  // the same context rather than dismissed, retain the in-memory draft so
  // recovery does not discard the user's title/body/base edits. Reopening a
  // different context still reseeds (guarded by the eligibility key).
  retainDraftWhenClosed?: boolean
  onBranchChangedByGeneration?: () => Promise<void>
  generation?: {
    generating: boolean
    generateError: string | null
    seedRestoreKey?: string | null
    seed?: PullRequestDraftFields | null
    seedFieldRevisions?: PullRequestFieldRevisions | null
    onSeedRestored?: (seedRestoreKey: string) => void
    onGenerate: (
      fields: PullRequestDraftFields,
      fieldRevisions: PullRequestFieldRevisions,
      overrides?: RuntimeGeneratePullRequestFieldsOverrides
    ) => void
    onCancelGenerate: () => void
  }
}

export type GenerationSeed = {
  requestId: number
  fieldRevisions: PullRequestFieldRevisions
  context: RuntimeGitContext
}

export function createInitialPullRequestFieldRevisions(): PullRequestFieldRevisions {
  return {
    base: 0,
    title: 0,
    body: 0,
    draft: 0
  }
}
