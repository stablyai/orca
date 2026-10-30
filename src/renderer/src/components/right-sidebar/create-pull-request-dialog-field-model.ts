import type { WorkspaceAttachmentMetadata } from '../../../../shared/workspace-attachment-legacy'
import type { AppState } from '@/store'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type {
  RuntimeGeneratePullRequestFieldsOverrides,
  RuntimeGitContext
} from '@/runtime/runtime-git-client-context'
import type { Repo } from '../../../../shared/repo-types'
import type { HostedReviewCreationEligibility } from '../../../../shared/hosted-review'
import type { SourceControlAiPrCreationDefaults } from '../../../../shared/source-control-ai-types'
import type {
  PullRequestFieldRevisions,
  PullRequestGenerationFields
} from '@/store/slices/pull-request-generation'
import type { PullRequestGenerationOptions } from '@/store/slices/pull-request-generation-auto-submit'

export type PullRequestGenerationOutcome = { result: PullRequestGenerationFields | null }

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
  workspace?: WorkspaceAttachmentMetadata | null
  eligibility: HostedReviewCreationEligibility | null
  currentBaseRef?: string | null
  repo?: Pick<Repo, 'sourceControlAi'> | null
  /** Generation preferences; routing comes from `target`. */
  settings: AppState['settings']
  /** The worktree owner's transport. */
  target: RuntimeClientTarget | null
  submitting: boolean
  prCreationDefaults?: SourceControlAiPrCreationDefaults
  sourceControlAiActionsVisible?: boolean
  // Retain drafts across temporary same-context hiding; different eligibility contexts still reseed.
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
      overrides?: RuntimeGeneratePullRequestFieldsOverrides,
      options?: PullRequestGenerationOptions
    ) => void | Promise<PullRequestGenerationOutcome | undefined>
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
