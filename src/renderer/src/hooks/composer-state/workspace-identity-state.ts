import type { ComposerModel } from './composer-model'

type WorkspaceIdentityStateInput = Pick<
  ComposerModel,
  | 'initialBaseBranch'
  | 'initialLinearBranchName'
  | 'initialLinkedWorkItem'
  | 'linkedWorkItem'
  | 'linkedWorkItemSeedIdentity'
  | 'name'
  | 'newWorkspaceDraft'
  | 'persistDraft'
  | 'selectedRepoConnectionId'
  | 'selectedRepoSettings'
  | 'settings'
>

import { useState, useMemo } from 'react'
import { getLinkedWorkItemProvider, isGitLabIssueUrl } from '@/lib/new-workspace'
import {
  type SmartNameMode,
  isBlockingJiraUrlIntent
} from '@/components/new-workspace/smart-workspace-source-results'
import type { GitPushTarget } from '../../../../shared/worktree/types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { filterEnabledTuiAgents, isTuiAgentEnabled } from '../../../../shared/tui-agent-selection'
import { getAgentCatalog } from '@/lib/agent-catalog'
import { useAppStore } from '@/store'

export function useWorkspaceIdentityState(input: WorkspaceIdentityStateInput) {
  const {
    initialBaseBranch,
    initialLinearBranchName,
    initialLinkedWorkItem,
    linkedWorkItem,
    linkedWorkItemSeedIdentity,
    name,
    newWorkspaceDraft,
    persistDraft,
    selectedRepoConnectionId,
    selectedRepoSettings,
    settings
  } = input

  const [linkedIssue, setLinkedIssue] = useState<string>(() => {
    if (linkedWorkItemSeedIdentity?.type === 'issue') {
      return String(linkedWorkItemSeedIdentity.number)
    }
    if (persistDraft && newWorkspaceDraft?.linkedIssue) {
      return newWorkspaceDraft.linkedIssue
    }
    if (
      initialLinkedWorkItem?.type === 'issue' &&
      getLinkedWorkItemProvider(initialLinkedWorkItem) === 'github'
    ) {
      return String(initialLinkedWorkItem.number)
    }
    return ''
  })

  const [linkedPR, setLinkedPR] = useState<number | null>(() => {
    if (linkedWorkItemSeedIdentity?.type === 'pr') {
      return linkedWorkItemSeedIdentity.number
    }
    if (linkedWorkItemSeedIdentity?.type === 'issue') {
      return null
    }
    if (persistDraft && newWorkspaceDraft?.linkedPR !== undefined) {
      return newWorkspaceDraft.linkedPR
    }
    return initialLinkedWorkItem?.type === 'pr' ? initialLinkedWorkItem.number : null
  })

  // Why: GitLab parallels of linkedIssue/linkedPR, kept as separate state so existing GitHub auto-name/badge/persistence paths stay untouched.
  const [linkedGitLabIssue, setLinkedGitLabIssue] = useState<number | null>(() => {
    if (persistDraft && newWorkspaceDraft?.linkedGitLabIssue !== undefined) {
      return newWorkspaceDraft.linkedGitLabIssue
    }
    return initialLinkedWorkItem?.type === 'issue' && isGitLabIssueUrl(initialLinkedWorkItem.url)
      ? initialLinkedWorkItem.number
      : null
  })

  const [linkedGitLabMR, setLinkedGitLabMR] = useState<number | null>(() => {
    if (persistDraft && newWorkspaceDraft?.linkedGitLabMR !== undefined) {
      return newWorkspaceDraft.linkedGitLabMR
    }
    return initialLinkedWorkItem?.type === 'mr' ? initialLinkedWorkItem.number : null
  })

  const [baseBranch, setBaseBranch] = useState<string | undefined>(
    persistDraft ? newWorkspaceDraft?.baseBranch : initialBaseBranch
  )

  const [compareBaseRef, setCompareBaseRef] = useState<string | undefined>(
    persistDraft ? newWorkspaceDraft?.compareBaseRef : undefined
  )

  const [branchNameOverride, setBranchNameOverride] = useState<string | undefined>(
    initialLinearBranchName
  )

  const [parentWorktreeId, setParentWorktreeId] = useState<string | null>(null)

  const [branchNameOverridePreservesNameEdits, setBranchNameOverridePreservesNameEdits] = useState(
    Boolean(initialLinearBranchName)
  )

  const [smartNameMode, setSmartNameMode] = useState<SmartNameMode>('smart')

  // Why: a pasted Jira URL is not a workspace name yet — block create until it resolves to an issue.
  const sourceIntentBlocksCreate = !linkedWorkItem && isBlockingJiraUrlIntent(smartNameMode, name)

  // Why (#5181): reuseEligibleBranch = local branch name eligible for checkout-reuse (null if none); reuseSelectedBranch = the checkbox that enacts it.
  const [reuseEligibleBranch, setReuseEligibleBranch] = useState<string | null>(null)

  const [reuseSelectedBranch, setReuseSelectedBranch] = useState(false)

  const [pushTarget, setPushTarget] = useState<GitPushTarget | undefined>(undefined)

  // Why: when a repo switch wipes a prior Start-from selection, surface the reset inline (e.g. "was PR #8778") so it doesn't slip past the user.
  const [startFromResetHint, setStartFromResetHint] = useState<string | null>(null)

  // Why: a fork PR with "Allow edits from maintainers" off can't be pushed to; warn (don't block) so a rejected push isn't a surprise.
  const [forkPushWarning, setForkPushWarning] = useState<string | null>(null)

  const disabledTuiAgentKey = (settings?.disabledTuiAgents ?? []).join('\u0000')

  const disabledTuiAgents = useMemo<TuiAgent[]>(
    () => settings?.disabledTuiAgents ?? [],
    // Why: settings IPC clones arrays, so key on the disabled-agent content, not the array ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [disabledTuiAgentKey]
  )

  // Why: the long-form composer requires a real TuiAgent, so a global 'blank' pref collapses to Claude (blank only exists in quick-create).
  const enabledCatalogAgents = useMemo(
    () =>
      filterEnabledTuiAgents(
        getAgentCatalog().map((agent) => agent.id),
        disabledTuiAgents
      ),
    [disabledTuiAgents]
  )

  const fallbackDefaultAgent: TuiAgent =
    settings?.defaultTuiAgent &&
    settings.defaultTuiAgent !== 'blank' &&
    isTuiAgentEnabled(settings.defaultTuiAgent, disabledTuiAgents)
      ? settings.defaultTuiAgent
      : (enabledCatalogAgents[0] ?? 'claude')

  const [tuiAgent, setTuiAgent] = useState<TuiAgent>(
    persistDraft ? (newWorkspaceDraft?.agent ?? fallbackDefaultAgent) : fallbackDefaultAgent
  )

  // Why: for a repo on an SSH host or runtime env, read the per-host agent list so the dialog shows the host's installed agents, not local.
  const connectionId = selectedRepoConnectionId

  const isRemote = typeof connectionId === 'string'

  const runtimeEnvironmentId = selectedRepoSettings?.activeRuntimeEnvironmentId?.trim() || null

  const detectedAgentList = useAppStore((s) => {
    if (isRemote) {
      return s.remoteDetectedAgentIds[connectionId] ?? null
    }
    if (runtimeEnvironmentId) {
      return s.runtimeDetectedAgentIds[runtimeEnvironmentId] ?? null
    }
    return s.detectedAgentIds
  })

  const ensureDetectedAgents = useAppStore((s) => s.ensureDetectedAgents)

  const ensureRemoteDetectedAgents = useAppStore((s) => s.ensureRemoteDetectedAgents)

  const ensureRuntimeDetectedAgents = useAppStore((s) => s.ensureRuntimeDetectedAgents)

  const detectedAgentIds = useMemo<Set<TuiAgent> | null>(
    () => (detectedAgentList ? new Set(detectedAgentList) : null),
    [detectedAgentList]
  )

  return {
    linkedIssue,
    setLinkedIssue,
    linkedPR,
    setLinkedPR,
    linkedGitLabIssue,
    setLinkedGitLabIssue,
    linkedGitLabMR,
    setLinkedGitLabMR,
    baseBranch,
    setBaseBranch,
    compareBaseRef,
    setCompareBaseRef,
    branchNameOverride,
    setBranchNameOverride,
    parentWorktreeId,
    setParentWorktreeId,
    branchNameOverridePreservesNameEdits,
    setBranchNameOverridePreservesNameEdits,
    smartNameMode,
    setSmartNameMode,
    sourceIntentBlocksCreate,
    reuseEligibleBranch,
    setReuseEligibleBranch,
    reuseSelectedBranch,
    setReuseSelectedBranch,
    pushTarget,
    setPushTarget,
    startFromResetHint,
    setStartFromResetHint,
    forkPushWarning,
    setForkPushWarning,
    disabledTuiAgentKey,
    disabledTuiAgents,
    enabledCatalogAgents,
    fallbackDefaultAgent,
    tuiAgent,
    setTuiAgent,
    connectionId,
    isRemote,
    runtimeEnvironmentId,
    detectedAgentList,
    ensureDetectedAgents,
    ensureRemoteDetectedAgents,
    ensureRuntimeDetectedAgents,
    detectedAgentIds
  }
}
