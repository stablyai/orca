import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import type { SmartGitHubPrStartPointSelection } from './source-selection-decisions'

export type ComposerDecisions = {
  canResolveFolderSmartGitHubSubmit: (input: { hasFolderSourceRepos: boolean }) => boolean
  getInitialAutoManagedWorkspaceName: (input: {
    draftName?: string | null
    draftLinkedWorkItem?: LinkedWorkItemSummary | null
    initialName: string
    initialLinkedWorkItem?: LinkedWorkItemSummary | null
  }) => string
  getInitialGitHubPrStartPointSelection: (input: {
    item: GitHubWorkItem | null | undefined
    linkedWorkItem: LinkedWorkItemSummary | null | undefined
    repoId: string | null | undefined
  }) => SmartGitHubPrStartPointSelection | null
  getMatchingLinkedTaskSourceContext: (
    item: LinkedWorkItemSummary | null | undefined,
    context: TaskSourceContext | null | undefined
  ) => TaskSourceContext | null
  isExplicitWorkspaceNameInput: (input: { name: string; lastAutoName: string }) => boolean
  resolveInitialWorkspaceRunSeed: (input: {
    draftProjectId?: string | null
    draftHostId?: string | null
    draftProjectHostSetupId?: string | null
    initialTaskSourceContext?: Pick<
      TaskSourceContext,
      'projectId' | 'hostId' | 'projectHostSetupId'
    > | null
  }) => {
    projectId: string | null
    hostId: ExecutionHostId | null
    projectHostSetupId: string | null
  }
  resolveSmartGitHubCreateNames: (input: {
    resolutionKind: 'metadata-only' | 'pr-start-point'
    smartWorkspaceName: string
    smartDisplayName: string | undefined
    fallbackWorkspaceName: string
    nameIsAutoManaged: boolean
  }) => { workspaceName: string; displayName: string | undefined }
  retargetGitHubPrStartPointSelection: (
    selection: SmartGitHubPrStartPointSelection | null,
    repoId: string
  ) => SmartGitHubPrStartPointSelection | null
}
