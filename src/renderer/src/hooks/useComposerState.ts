import type { RefObject } from 'react'
import {
  getLinkedWorkItemSuggestedName,
  getLinkedWorkItemWorkspaceName,
  type LinkedWorkItemSummary
} from '@/lib/new-workspace'
import type { GitHubWorkItem } from '../../../shared/github/work-item-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import type { WorkspaceSource as WorkspaceCreateTelemetrySource } from '../../../shared/workspace-source'
import type { WorkspaceStatus } from '../../../shared/worktree/types'
import { normalizeExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import { isWorkItemLookupText } from '@/lib/work-item-lookup-text'
import { resolveGitHubWorkItemIdentity } from '@/lib/github-work-item-identity'
import { isWorkspaceLinkedItemSourceContextMatch } from '../../../shared/workspace-linked-item-source-context'
import {
  getGitHubLinkedWorkItemIdentity,
  type SmartGitHubPrStartPointSelection
} from './composer-state/source-selection-decisions'
import { buildComposerCardProps } from './composer-state/composer-card-props'
import type { ComposerDecisions } from './composer-state/composer-decisions'
import { useComposerTargetState } from './composer-state/composer-target-state'
import { useComposerExternalSync } from './composer-state/composer-external-sync'
import { useComposerSourceState } from './composer-state/composer-source-state'
import { useComposerSubmitOrchestration } from './composer-state/composer-submit-orchestration'
import { assembleComposerModel } from './composer-state/assemble-composer-model'
import type {
  ComposerCardActionProps,
  ComposerCardSourceProps
} from './composer-state/composer-card-contract'

export type UseComposerStateOptions = {
  initialRepoId?: string
  initialEphemeralVmRecipeId?: string
  initialProjectGroupId?: string
  initialName?: string
  initialPrompt?: string
  initialLinkedWorkItem?: LinkedWorkItemSummary | null
  initialGitHubWorkItem?: GitHubWorkItem | null
  initialTaskSourceContext?: TaskSourceContext | null
  initialWorkspaceStatus?: WorkspaceStatus
  initialBaseBranch?: string
  persistDraft: boolean
  onCreated?: () => void
  isSubmissionCancelled?: () => boolean
  repoIdOverride?: string
  onRepoIdOverrideChange?: (value: string) => void
  telemetrySource?: WorkspaceCreateTelemetrySource
  enableIssueAutomation?: boolean
  createGateMode?: 'full' | 'quick'
}

export type ComposerCardProps = ComposerCardSourceProps & ComposerCardActionProps

export type UseComposerStateResult = {
  cardProps: ComposerCardProps
  composerRef: RefObject<HTMLDivElement | null>
  onComposerNodeChange: (node: HTMLDivElement | null) => void
  promptTextareaRef: RefObject<HTMLTextAreaElement | null>
  nameInputRef: RefObject<HTMLInputElement | null>
  submit: () => Promise<void>
  submitQuick: (agent: TuiAgent | null) => Promise<void>
  createDisabled: boolean
  selectAddedProjectRepo: (repoId: string) => void
}

export function canResolveFolderSmartGitHubSubmit({
  hasFolderSourceRepos
}: {
  hasFolderSourceRepos: boolean
}): boolean {
  return hasFolderSourceRepos
}

export function isExplicitWorkspaceNameInput({
  name,
  lastAutoName
}: {
  name: string
  lastAutoName: string
}): boolean {
  // Why: a user-authored name must win over linked-item and first-message AI naming.
  return Boolean(name.trim()) && name !== lastAutoName && !isWorkItemLookupText(name)
}

export function resolveSmartGitHubCreateNames({
  resolutionKind,
  smartWorkspaceName,
  smartDisplayName,
  fallbackWorkspaceName,
  nameIsAutoManaged
}: {
  resolutionKind: 'metadata-only' | 'pr-start-point'
  smartWorkspaceName: string
  smartDisplayName: string | undefined
  fallbackWorkspaceName: string
  nameIsAutoManaged: boolean
}): { workspaceName: string; displayName: string | undefined } {
  if (resolutionKind === 'pr-start-point' && !nameIsAutoManaged && fallbackWorkspaceName) {
    return { workspaceName: fallbackWorkspaceName, displayName: undefined }
  }
  return { workspaceName: smartWorkspaceName, displayName: smartDisplayName }
}

function getLinkedWorkItemSeedName(item: LinkedWorkItemSummary | null | undefined): string {
  if (!item) {
    return ''
  }
  return getLinkedWorkItemWorkspaceName(item)?.seedName ?? getLinkedWorkItemSuggestedName(item)
}

export function getInitialAutoManagedWorkspaceName({
  draftName,
  draftLinkedWorkItem,
  initialName,
  initialLinkedWorkItem
}: {
  draftName?: string | null
  draftLinkedWorkItem?: LinkedWorkItemSummary | null
  initialName: string
  initialLinkedWorkItem?: LinkedWorkItemSummary | null
}): string {
  // Why: a prefilled name counts as user input unless it exactly matches the linked-item seed Orca generated.
  const candidateName = draftName ?? initialName
  const seedName = getLinkedWorkItemSeedName(draftLinkedWorkItem ?? initialLinkedWorkItem)
  return candidateName && seedName && candidateName === seedName ? candidateName : ''
}

export type InitialWorkspaceRunSeedInput = {
  draftProjectId?: string | null
  draftHostId?: string | null
  draftProjectHostSetupId?: string | null
  initialTaskSourceContext?: Pick<
    TaskSourceContext,
    'projectId' | 'hostId' | 'projectHostSetupId'
  > | null
}

export function resolveInitialWorkspaceRunSeed({
  draftProjectId,
  draftHostId,
  draftProjectHostSetupId,
  initialTaskSourceContext
}: InitialWorkspaceRunSeedInput): {
  projectId: string | null
  hostId: ExecutionHostId | null
  projectHostSetupId: string | null
} {
  return {
    projectId: draftProjectId ?? initialTaskSourceContext?.projectId ?? null,
    hostId: normalizeExecutionHostId(draftHostId ?? initialTaskSourceContext?.hostId),
    projectHostSetupId:
      draftProjectHostSetupId ?? initialTaskSourceContext?.projectHostSetupId ?? null
  }
}

export function getInitialGitHubPrStartPointSelection({
  item,
  linkedWorkItem,
  repoId
}: {
  item: GitHubWorkItem | null | undefined
  linkedWorkItem: LinkedWorkItemSummary | null | undefined
  repoId: string | null | undefined
}): SmartGitHubPrStartPointSelection | null {
  if (!item || !repoId) {
    return null
  }
  const itemIdentity = resolveGitHubWorkItemIdentity(item)
  const linkedIdentity = getGitHubLinkedWorkItemIdentity(linkedWorkItem)
  if (
    itemIdentity.type !== 'pr' ||
    linkedIdentity?.type !== 'pr' ||
    linkedIdentity.number !== itemIdentity.number
  ) {
    return null
  }
  return {
    repoId,
    item: { ...item, type: itemIdentity.type, number: itemIdentity.number }
  }
}

export function retargetGitHubPrStartPointSelection(
  selection: SmartGitHubPrStartPointSelection | null,
  repoId: string
): SmartGitHubPrStartPointSelection | null {
  return selection ? { repoId, item: selection.item } : null
}

export function getMatchingLinkedTaskSourceContext(
  item: LinkedWorkItemSummary | null | undefined,
  context: TaskSourceContext | null | undefined
): TaskSourceContext | null {
  return isWorkspaceLinkedItemSourceContextMatch(item, context) ? (context ?? null) : null
}

const COMPOSER_DECISIONS: ComposerDecisions = {
  canResolveFolderSmartGitHubSubmit,
  getInitialAutoManagedWorkspaceName,
  getInitialGitHubPrStartPointSelection,
  getMatchingLinkedTaskSourceContext,
  isExplicitWorkspaceNameInput,
  resolveInitialWorkspaceRunSeed,
  resolveSmartGitHubCreateNames,
  retargetGitHubPrStartPointSelection
}

export function useComposerState(options: UseComposerStateOptions): UseComposerStateResult {
  const target = useComposerTargetState(options, COMPOSER_DECISIONS)
  const external = useComposerExternalSync(target)
  const source = useComposerSourceState(target, external)
  const submit = useComposerSubmitOrchestration(target, external, source)
  const model = assembleComposerModel(target, external, source, submit)
  const builtCard = buildComposerCardProps(model)
  const cardProps: ComposerCardProps = builtCard.cardProps
  const { createDisabled } = builtCard
  return {
    cardProps,
    composerRef: model.composerRef,
    onComposerNodeChange: model.handleComposerNodeChange,
    promptTextareaRef: model.promptTextareaRef,
    nameInputRef: model.nameInputRef,
    submit: model.submit,
    submitQuick: model.submitQuick,
    createDisabled,
    selectAddedProjectRepo: model.selectAddedProjectRepo
  }
}
