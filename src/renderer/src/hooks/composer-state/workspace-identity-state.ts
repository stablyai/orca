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
  | 'selectedRepoRuntimeEnvironmentId'
  | 'settings'
>

import { useState, useMemo, useCallback, type SetStateAction } from 'react'
import type { CreateWorktreeArgs } from '../../../../shared/worktree/create-types'
import { getLinkedWorkItemProvider, isGitLabIssueUrl } from '@/lib/new-workspace'
import {
  type SmartNameMode,
  isBlockingJiraUrlIntent
} from '../../../../shared/new-workspace/smart-workspace-source-results'
import type { GitPushTarget } from '../../../../shared/worktree/types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { filterEnabledTuiAgents, isTuiAgentEnabled } from '../../../../shared/tui-agent-selection'
import { getAgentCatalog } from '@/lib/agent-catalog'
import { useAppStore } from '@/store'

/** Older drafts lack naming intent; restore baseBranch as the branch pick it represented when saved. */
export function resolveDraftBaseBranchNamesWorkspace(args: {
  persistDraft: boolean
  draftValue: boolean | undefined
}): boolean {
  return args.persistDraft ? (args.draftValue ?? true) : true
}

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
    selectedRepoRuntimeEnvironmentId,
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
  // Branch-as-name selections get source pills; checkout-base picks must not hide the typed name.
  const [baseBranchNamesWorkspace, setBaseBranchNamesWorkspace] = useState(() =>
    resolveDraftBaseBranchNamesWorkspace({
      persistDraft,
      draftValue: newWorkspaceDraft?.baseBranchNamesWorkspace
    })
  )

  const [compareBaseRef, setCompareBaseRef] = useState<string | undefined>(
    persistDraft ? newWorkspaceDraft?.compareBaseRef : undefined
  )

  const [branchNameOverride, updateBranchNameOverride] = useState<string | undefined>(
    initialLinearBranchName
  )
  const [branchIntent, setBranchIntent] = useState<CreateWorktreeArgs['branchIntent']>()
  const setBranchNameOverride = useCallback((value: SetStateAction<string | undefined>) => {
    setBranchIntent(undefined)
    updateBranchNameOverride(value)
  }, [])

  const [parentWorktreeId, setParentWorktreeId] = useState<string | null>(null)

  const [branchNameOverridePreservesNameEdits, setBranchNameOverridePreservesNameEdits] = useState(
    Boolean(initialLinearBranchName)
  )

  const [smartNameMode, setSmartNameMode] = useState<SmartNameMode>('smart')

  // Why: a pasted Jira URL is not a workspace name yet — block create until it resolves to an issue.
  const sourceIntentBlocksCreate = !linkedWorkItem && isBlockingJiraUrlIntent(smartNameMode, name)

  const [reuseEligibleBranch, setReuseEligibleBranch] = useState<string | null>(null)

  const [reuseSelectedBranch, setReuseSelectedBranch] = useState(false)

  const [pushTarget, setPushTarget] = useState<GitPushTarget | undefined>(undefined)

  // Show invalidated checkout-source labels inline so repo-switch resets remain visible.
  const [startFromResetHint, setStartFromResetHint] = useState<string | null>(null)

  // Warn when fork PRs disable maintainer edits, before a rejected push surprises the user.
  const [forkPushWarning, setForkPushWarning] = useState<string | null>(null)

  const disabledTuiAgentKey = (settings?.disabledTuiAgents ?? []).join('\u0000')

  const disabledTuiAgents = useMemo<TuiAgent[]>(
    () => settings?.disabledTuiAgents ?? [],
    // Why: settings IPC clones arrays, so key on the disabled-agent content, not the array ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [disabledTuiAgentKey]
  )

  // Long-form requires a real agent; blank is quick-create-only and falls back to Claude here.
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

  // Host-owned repos must show their host’s installed agents rather than the client’s inventory.
  const runtimeEnvironmentId = selectedRepoRuntimeEnvironmentId?.trim() || null

  // Kept as-is: uploads fence on the worktree's real host, which for a server repo is its target.
  const connectionId = selectedRepoConnectionId

  // Server-owned connection IDs name the server’s SSH target; ask that server to probe agents.
  const isRemote = typeof connectionId === 'string' && !runtimeEnvironmentId

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
    baseBranchNamesWorkspace,
    setBaseBranchNamesWorkspace,
    compareBaseRef,
    setCompareBaseRef,
    branchNameOverride,
    branchIntent,
    setBranchIntent,
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
