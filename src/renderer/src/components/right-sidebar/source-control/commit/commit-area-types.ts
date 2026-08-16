import type { DropdownActionKind, DropdownEntry } from '../../source-control-dropdown-item-types'
import type { PrimaryAction, RemoteOpKind } from '../../source-control-primary-action'
import type { SourceControlPushRecovery } from '../sync/push-recovery'
import type {
  SourceControlActionRecipe,
  SourceControlLaunchActionId
} from '../../../../../../shared/source-control-ai-actions'
import type { SourceControlAiWriteTarget } from '../../../../../../shared/source-control-ai-recipe-save'

export type CreatePrIntentNotice = {
  message: string
  tone: 'muted' | 'destructive'
  action?: 'settings'
}

export type CommitAreaProps = {
  worktreeId: string | null
  groupId: string | null
  connectionId?: string | null
  repoId?: string | null
  launchPlatform?: NodeJS.Platform
  commitMessage: string
  commitError: string | null
  commitFailureRecoveryPrompt: string | null
  pushRecovery: SourceControlPushRecovery | null
  remoteActionError: string | null
  createPrIntentNotice?: CreatePrIntentNotice | null
  isCommitting: boolean
  isFixingCommitFailureWithAI: boolean
  isFixingPushFailureWithAI: boolean
  isCreatingPr?: boolean
  isCreatePrIntentInFlight?: boolean
  showComposer?: boolean
  sourceControlAiActionsVisible: boolean
  aiAgentConfigured: boolean
  isGenerating: boolean
  generateError: string | null
  stagedCount: number
  hasPartiallyStagedChanges: boolean
  hasUnresolvedConflicts: boolean
  isRemoteOperationActive: boolean
  inFlightRemoteOpKind: RemoteOpKind | null
  primaryAction: PrimaryAction
  dropdownItems: DropdownEntry[]
  fixCommitFailureRecipe?: SourceControlActionRecipe
  fixPushFailureRecipe?: SourceControlActionRecipe
  onCommitMessageChange: (message: string) => void
  onGenerate: () => void
  onCancelGenerate: () => void
  onSaveLaunchActionDefault?: (
    target: SourceControlAiWriteTarget,
    actionId: SourceControlLaunchActionId,
    recipe: SourceControlActionRecipe
  ) => void | Promise<void>
  onOpenSourceControlAiSettings?: () => void
  onFixCommitFailureWithAI: (promptOverride?: string) => Promise<boolean> | boolean
  onFixPushFailureWithAI: (promptOverride?: string) => Promise<boolean> | boolean
  onPrimaryAction: () => void
  onDropdownAction: (kind: DropdownActionKind) => void
}

/** Notice-strip subset of {@link CommitAreaProps}, plus the commit-failure fields CommitArea derives locally. */
export type CommitNoticesProps = Pick<
  CommitAreaProps,
  | 'worktreeId'
  | 'groupId'
  | 'connectionId'
  | 'repoId'
  | 'launchPlatform'
  | 'commitError'
  | 'commitFailureRecoveryPrompt'
  | 'pushRecovery'
  | 'remoteActionError'
  | 'createPrIntentNotice'
  | 'generateError'
  | 'sourceControlAiActionsVisible'
  | 'isFixingCommitFailureWithAI'
  | 'isFixingPushFailureWithAI'
  | 'fixCommitFailureRecipe'
  | 'fixPushFailureRecipe'
  | 'onSaveLaunchActionDefault'
  | 'onOpenSourceControlAiSettings'
  | 'onFixCommitFailureWithAI'
  | 'onFixPushFailureWithAI'
> & {
  commitFailureSummary: string | null
  commitFailureKindLabel: string | null
  hasCommitFailureDetails: boolean
}
