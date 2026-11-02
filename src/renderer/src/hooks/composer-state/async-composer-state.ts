import type { ComposerModel } from './composer-model'

type ComposerAsyncStateInput = Pick<
  ComposerModel,
  | 'agentPrompt'
  | 'connectionId'
  | 'decisions'
  | 'draftLinkedWorkItemSeed'
  | 'enableIssueAutomation'
  | 'initialGitHubWorkItem'
  | 'initialLinkedWorkItemSeed'
  | 'initialName'
  | 'initialRepoId'
  | 'name'
  | 'newWorkspaceDraft'
  | 'note'
  | 'persistDraft'
  | 'selectedRepo'
  | 'selectedRepoConnectionId'
  | 'selectedRepoHookContextKey'
  | 'selectedRepoIsGit'
  | 'setName'
>

import { useState, useRef, useEffect } from 'react'
import type { OrcaHooks, SetupAgentStartupPolicy } from '../../../../shared/orca-yaml-hook-types'
import type { IssueCommandReadResult } from '@/runtime/runtime-hooks-client'
import type { WorkspaceCreateErrorDisplay } from '@/lib/workspace-create-error-format'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import { CONTEXTUAL_TOUR_ENABLE_AUTO_WORKSPACE_NAME_EVENT } from '@/components/contextual-tours/contextual-tour-composer-events'
import type { GitHubRepositoryIdentity } from '../../../../shared/github/pull-request-types'
import { getRepoSetupAgentStartupPolicy } from './setup-policy-decisions'
import { getJiraIssueKeyCasingSeedOptions } from '@/lib/jira-issue-key-casing'
import type {
  SmartGitHubPrStartPointSelection,
  SmartSourceSelection
} from './source-selection-decisions'

export function useComposerAsyncState(input: ComposerAsyncStateInput) {
  const {
    agentPrompt,
    connectionId,
    decisions,
    draftLinkedWorkItemSeed,
    enableIssueAutomation,
    initialGitHubWorkItem,
    initialLinkedWorkItemSeed,
    initialName,
    initialRepoId,
    name,
    newWorkspaceDraft,
    note,
    persistDraft,
    selectedRepo,
    selectedRepoConnectionId,
    selectedRepoHookContextKey,
    selectedRepoIsGit,
    setName
  } = input
  const { getInitialAutoManagedWorkspaceName, getInitialGitHubPrStartPointSelection } = decisions

  const [yamlHooks, setYamlHooks] = useState<OrcaHooks | null>(null)

  const [checkedHooksContextKey, setCheckedHooksContextKey] = useState<string | null>(null)

  const [loadedIssueCommand, setLoadedIssueCommand] = useState<{
    contextKey: string
    result: IssueCommandReadResult
  } | null>(null)

  const currentIssueCommand =
    loadedIssueCommand?.contextKey === selectedRepoHookContextKey ? loadedIssueCommand.result : null

  const issueCommandTemplate = currentIssueCommand?.effectiveContent ?? ''

  const hasLoadedIssueCommand =
    !selectedRepoIsGit || !enableIssueAutomation || currentIssueCommand !== null

  const [setupDecision, setSetupDecision] = useState<'run' | 'skip' | null>(null)

  const [setupAgentStartupPolicy, setSetupAgentStartupPolicy] = useState<SetupAgentStartupPolicy>(
    () => getRepoSetupAgentStartupPolicy(selectedRepo)
  )

  const setupAgentStartupPolicyRef = useRef(setupAgentStartupPolicy)

  useEffect(() => {
    setupAgentStartupPolicyRef.current = setupAgentStartupPolicy
  }, [setupAgentStartupPolicy])

  const setupAgentStartupPolicySaveRef = useRef<{
    repoId: string
    policy: SetupAgentStartupPolicy
    promise: Promise<boolean>
  } | null>(null)

  const setupAgentStartupPolicyDraftRef = useRef<{
    repoId: string
    policy: SetupAgentStartupPolicy
  } | null>(null)

  const [creating, setCreating] = useState(false)

  const [createError, setCreateError] = useState<WorkspaceCreateErrorDisplay | null>(null)

  const [createMultiple, setCreateMultiple] = useState(false)

  const [advancedOpen, setAdvancedOpen] = useState(
    persistDraft ? Boolean((newWorkspaceDraft?.note ?? '').trim()) : false
  )

  const [sparseEnabled, setSparseEnabled] = useState(false)

  const [sparseDirectories, setSparseDirectories] = useState('')

  const [sparseSelectedPresetId, setSparseSelectedPresetId] = useState<string | null>(null)

  const [linkPopoverOpen, setLinkPopoverOpen] = useState(false)

  const [linkQuery, setLinkQuery] = useState('')

  const [linkDebouncedQuery, setLinkDebouncedQuery] = useState('')

  const [linkItems, setLinkItems] = useState<GitHubWorkItem[]>([])

  const [linkItemsLoading, setLinkItemsLoading] = useState(false)

  const [linkDirectItem, setLinkDirectItem] = useState<GitHubWorkItem | null>(null)

  const [linkDirectLoading, setLinkDirectLoading] = useState(false)

  const lastAutoNameRef = useRef<string>(undefined!)
  lastAutoNameRef.current ??= getInitialAutoManagedWorkspaceName({
    draftName: persistDraft ? newWorkspaceDraft?.name : null,
    draftLinkedWorkItem: persistDraft ? draftLinkedWorkItemSeed : null,
    initialName,
    initialLinkedWorkItem: initialLinkedWorkItemSeed,
    ...getJiraIssueKeyCasingSeedOptions()
  })

  const nameRef = useRef<string>(name)

  const branchAutoNameRef = useRef<string>('')

  // Track auto-prefilled PR notes separately so source changes never overwrite user text.
  const lastAutoNoteRef = useRef<string>('')

  // Read the latest note without rebuilding PR-selection callbacks on every keystroke.
  const noteRef = useRef<string>(note)

  useEffect(() => {
    nameRef.current = name
    noteRef.current = note
  }, [name, note])

  // Retain PR checkout intent while async refs resolve; lazy state accepts null without repeatedly seeding during render.
  const [initialSmartGitHubPrStartPointSelection] =
    useState<SmartGitHubPrStartPointSelection | null>(() =>
      getInitialGitHubPrStartPointSelection({
        item: initialGitHubWorkItem,
        linkedWorkItem: initialLinkedWorkItemSeed,
        repoId: selectedRepo?.id ?? initialRepoId
      })
    )
  const smartSourceSelectionRef = useRef<SmartSourceSelection | null>(
    initialSmartGitHubPrStartPointSelection
  )

  useEffect(() => {
    const clearAutoManagedName = (): void => {
      if (nameRef.current === lastAutoNameRef.current) {
        setName('')
        lastAutoNameRef.current = ''
        setCreateError(null)
      }
    }

    window.addEventListener(CONTEXTUAL_TOUR_ENABLE_AUTO_WORKSPACE_NAME_EVENT, clearAutoManagedName)
    return () => {
      window.removeEventListener(
        CONTEXTUAL_TOUR_ENABLE_AUTO_WORKSPACE_NAME_EVENT,
        clearAutoManagedName
      )
    }
  }, [setName])

  const composerRef = useRef<HTMLDivElement | null>(null)

  const promptTextareaRef = useRef<HTMLTextAreaElement | null>(null)

  const promptCaretFrameRef = useRef<number | null>(null)

  const nameInputRef = useRef<HTMLInputElement | null>(null)

  // Keep the once-mounted drop listener fresh without resubscribing and reordering composerDropStack.
  const agentPromptRef = useRef(agentPrompt)

  const connectionIdRef = useRef(connectionId)

  const selectedRepoConnectionIdRef = useRef(selectedRepoConnectionId)

  // Why: compare the full host-aware identity before linking a pasted PR URL to this repo.
  const [selectedRepoSlug, setSelectedRepoSlug] = useState<GitHubRepositoryIdentity | null>(null)

  const selectedRepoPath = selectedRepo?.path

  const selectedRepoPathRef = useRef<string | undefined>(selectedRepoPath)

  useEffect(() => {
    agentPromptRef.current = agentPrompt
    connectionIdRef.current = connectionId
    selectedRepoConnectionIdRef.current = selectedRepoConnectionId
    selectedRepoPathRef.current = selectedRepoPath
  }, [agentPrompt, connectionId, selectedRepoConnectionId, selectedRepoPath])

  return {
    yamlHooks,
    setYamlHooks,
    checkedHooksContextKey,
    setCheckedHooksContextKey,
    loadedIssueCommand,
    setLoadedIssueCommand,
    issueCommandTemplate,
    hasLoadedIssueCommand,
    setupDecision,
    setSetupDecision,
    setupAgentStartupPolicy,
    setSetupAgentStartupPolicy,
    setupAgentStartupPolicyRef,
    setupAgentStartupPolicySaveRef,
    setupAgentStartupPolicyDraftRef,
    creating,
    setCreating,
    createError,
    setCreateError,
    createMultiple,
    setCreateMultiple,
    advancedOpen,
    setAdvancedOpen,
    sparseEnabled,
    setSparseEnabled,
    sparseDirectories,
    setSparseDirectories,
    sparseSelectedPresetId,
    setSparseSelectedPresetId,
    linkPopoverOpen,
    setLinkPopoverOpen,
    linkQuery,
    setLinkQuery,
    linkDebouncedQuery,
    setLinkDebouncedQuery,
    linkItems,
    setLinkItems,
    linkItemsLoading,
    setLinkItemsLoading,
    linkDirectItem,
    setLinkDirectItem,
    linkDirectLoading,
    setLinkDirectLoading,
    lastAutoNameRef,
    nameRef,
    branchAutoNameRef,
    lastAutoNoteRef,
    noteRef,
    smartSourceSelectionRef,
    composerRef,
    promptTextareaRef,
    promptCaretFrameRef,
    nameInputRef,
    agentPromptRef,
    connectionIdRef,
    selectedRepoConnectionIdRef,
    selectedRepoSlug,
    setSelectedRepoSlug,
    selectedRepoPath,
    selectedRepoPathRef
  }
}
