import {
  getLinkedWorkItemSuggestedName,
  getLinkedWorkItemWorkspaceName
} from '../../../../shared/workspace-name'
import { normalizeExecutionHostId } from '../../../../shared/execution-host'
import { shouldApplyWorkspaceSourceAutoName } from '../../../../shared/new-workspace/workspace-source'
import { resolveGitHubWorkItemIdentity } from '@/lib/github-work-item-identity'
import { isWorkspaceLinkedItemSourceContextMatch } from '../../../../shared/workspace-linked-item-source-context'
import { getGitHubLinkedWorkItemIdentity } from './source-selection-decisions'
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
  isExplicitWorkspaceNameInput: (input: {
    name: string
    lastAutoName: string
    lookupTextIsQuery?: boolean
  }) => boolean
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

export function canResolveFolderSmartGitHubSubmit({
  hasFolderSourceRepos
}: {
  hasFolderSourceRepos: boolean
}): boolean {
  return hasFolderSourceRepos
}

export function isExplicitWorkspaceNameInput({
  name,
  lastAutoName,
  lookupTextIsQuery
}: {
  name: string
  lastAutoName: string
  lookupTextIsQuery?: boolean
}): boolean {
  // Why: a user-authored name must win over linked-item and first-message AI naming.
  return !shouldApplyWorkspaceSourceAutoName({ currentName: name, lastAutoName, lookupTextIsQuery })
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
    kind: 'github-pr',
    repoId,
    item: { ...item, type: itemIdentity.type, number: itemIdentity.number }
  }
}

export function retargetGitHubPrStartPointSelection(
  selection: SmartGitHubPrStartPointSelection | null,
  repoId: string
): SmartGitHubPrStartPointSelection | null {
  return selection ? { kind: 'github-pr', repoId, item: selection.item } : null
}

export function getMatchingLinkedTaskSourceContext(
  item: LinkedWorkItemSummary | null | undefined,
  context: TaskSourceContext | null | undefined
): TaskSourceContext | null {
  return isWorkspaceLinkedItemSourceContextMatch(item, context) ? (context ?? null) : null
}
