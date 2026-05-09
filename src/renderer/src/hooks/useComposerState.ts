/* eslint-disable max-lines -- Why: this hook co-locates every piece of state
the NewWorkspaceComposerCard reads or mutates, so both the full-page composer
and the global quick-composer modal can consume a single unified source of
truth without duplicating effects, derivation, or the create side-effect. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { AGENT_CATALOG } from '@/lib/agent-catalog'
import {
  parseGitHubIssueOrPRNumber,
  parseGitHubIssueOrPRLink,
  normalizeGitHubLinkQuery
} from '@/lib/github-links'
import { activateAndRevealWorktree, type AgentStartedTelemetry } from '@/lib/worktree-activation'
import { buildAgentDraftLaunchPlan, buildAgentStartupPlan } from '@/lib/tui-agent-startup'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import { tuiAgentToAgentKind } from '@/lib/telemetry'
import { isGitRepoKind } from '../../../shared/repo-kind'
import type {
  GitHubWorkItem,
  LinearIssue,
  OrcaHooks,
  SetupDecision,
  SetupRunPolicy,
  SparsePreset,
  TuiAgent,
  WorkspaceCreateTelemetrySource
} from '../../../shared/types'
import {
  ADD_ATTACHMENT_SHORTCUT,
  CLIENT_PLATFORM,
  DEFAULT_ISSUE_COMMAND_TEMPLATE,
  IS_MAC,
  buildAgentPromptWithContext,
  ensureAgentStartupInTerminal,
  getAttachmentLabel,
  getLinkedWorkItemSuggestedName,
  getSetupConfig,
  getWorkspaceSeedName,
  PER_REPO_FETCH_LIMIT,
  renderIssueCommandTemplate,
  type LinkedWorkItemSummary
} from '@/lib/new-workspace'
import { getSuggestedCreatureName } from '@/components/sidebar/worktree-name-suggestions'
import type { SmartWorkspaceNameSelection } from '@/components/new-workspace/SmartWorkspaceNameField'
import { ensureHooksConfirmed } from '@/lib/ensure-hooks-confirmed'
import { normalizeSparseDirectoryLines, sparseDirectoriesMatch } from '@/lib/sparse-paths'

export type UseComposerStateOptions = {
  initialRepoId?: string
  initialName?: string
  initialPrompt?: string
  initialLinkedWorkItem?: LinkedWorkItemSummary | null
  /** Seed the Start-from selection when the composer opens. Used by the
   *  Create-from → Quick fallback path so a PR pick that needs a setup
   *  decision still lands with the resolved PR head as the base branch. */
  initialBaseBranch?: string
  /** Why: the full-page composer persists drafts so users can navigate away
   *  without losing work; the quick-composer modal is transient and must not
   *  clobber or leak that long-running draft. */
  persistDraft: boolean
  /** Invoked after a successful createWorktree. The caller usually closes its
   *  surface here (palette modal, full page, etc.). */
  onCreated?: () => void
  /** Optional external repoId override — used by TaskPage's work-item list
   *  which drives repo selection from the page header, not the card. */
  repoIdOverride?: string
  onRepoIdOverrideChange?: (value: string) => void
  /** Telemetry surface that opened this composer. Threaded into
   *  `createWorktree` so `workspace_created.source` reflects the actual
   *  entry point (Cmd+J palette → `command_palette`, sidebar buttons →
   *  `sidebar`, keyboard shortcut → `shortcut`). Omitted callers default
   *  to `unknown` at the IPC boundary. */
  telemetrySource?: WorkspaceCreateTelemetrySource
}

export type ComposerCardProps = {
  eligibleRepos: ReturnType<typeof useAppStore.getState>['repos']
  repoId: string
  onRepoChange: (value: string) => void
  name: string
  onNameValueChange: (value: string) => void
  onSmartGitHubItemSelect: (item: GitHubWorkItem) => void
  onSmartBranchSelect: (refName: string) => void
  onSmartLinearIssueSelect: (issue: LinearIssue) => void
  smartNameSelection: SmartWorkspaceNameSelection | null
  onClearSmartNameSelection: () => void
  agentPrompt: string
  onAgentPromptChange: (value: string) => void
  onPromptKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void
  /** Rendered issueCommand template to preview inside the empty prompt
   *  textarea when the user has linked a work item but not typed anything. */
  linkedOnlyTemplatePreview: string | null
  attachmentPaths: string[]
  getAttachmentLabel: (pathValue: string) => string
  onAddAttachment: () => void
  onRemoveAttachment: (pathValue: string) => void
  addAttachmentShortcut: string
  linkedWorkItem: LinkedWorkItemSummary | null
  onRemoveLinkedWorkItem: () => void
  linkPopoverOpen: boolean
  onLinkPopoverOpenChange: (open: boolean) => void
  linkQuery: string
  onLinkQueryChange: (value: string) => void
  filteredLinkItems: GitHubWorkItem[]
  linkItemsLoading: boolean
  linkDirectLoading: boolean
  normalizedLinkQuery: { query: string }
  onSelectLinkedItem: (item: GitHubWorkItem) => void
  tuiAgent: TuiAgent
  onTuiAgentChange: (value: TuiAgent) => void
  detectedAgentIds: Set<TuiAgent> | null
  onOpenAgentSettings: () => void
  advancedOpen: boolean
  onToggleAdvanced: () => void
  createDisabled: boolean
  creating: boolean
  onCreate: () => void
  note: string
  onNoteChange: (value: string) => void
  baseBranch: string | undefined
  onBaseBranchChange: (next: string | undefined) => void
  /** Called when a PR is selected in the Start-from picker. Updates both
   *  baseBranch and linkedWorkItem/linkedPR in one pass. */
  onBaseBranchPrSelect: (baseBranch: string, item: GitHubWorkItem) => void
  /** PR number selected via the Start-from picker (when applicable). Used so the
   *  field can render "PR #N" copy. */
  baseBranchLinkedPrNumber: number | null
  /** Absolute path of the selected repo, used by Start-from picker for SWR. */
  selectedRepoPath: string | null
  /** True when the selected repo is a remote SSH repo; disables the PR tab in v1. */
  selectedRepoIsRemote: boolean
  /** Transient inline hint shown next to the Start-from trigger after a repo
   *  switch resets a prior selection (e.g. "was PR #8778"). Null when none. */
  startFromResetHint: string | null
  setupConfig: { source: 'yaml' | 'legacy'; command: string } | null
  requiresExplicitSetupChoice: boolean
  setupDecision: 'run' | 'skip' | null
  onSetupDecisionChange: (value: 'run' | 'skip') => void
  shouldWaitForSetupCheck: boolean
  resolvedSetupDecision: 'run' | 'skip' | null
  createError: string | null
  canUseSparseCheckout: boolean
  /** Saved presets for the currently-selected repo. Empty array when no
   *  presets exist or when the repo is remote. */
  sparsePresets: SparsePreset[]
  /** ID of the selected sparse preset. Null means sparse checkout is off. */
  sparseSelectedPresetId: string | null
  onSparseSelectPreset: (preset: SparsePreset | null) => void
}

export type UseComposerStateResult = {
  cardProps: ComposerCardProps
  /** Ref the consumer should attach to the composer wrapper so the global
   *  Enter-to-submit handler can scope its behavior to the visible composer. */
  composerRef: React.RefObject<HTMLDivElement | null>
  promptTextareaRef: React.RefObject<HTMLTextAreaElement | null>
  nameInputRef: React.RefObject<HTMLInputElement | null>
  submit: () => Promise<void>
  submitQuick: (agent: TuiAgent | null) => Promise<void>
  /** Invoked by the Enter handler to re-check whether submission should fire. */
  createDisabled: boolean
}

// Why: both the full-page TaskPage composer and the Cmd+J modal can be
// mounted simultaneously. Without instance scoping, a single native file
// drop fires every subscriber and duplicates attachments/prompt edits across
// the background draft and the visible modal. Route drops to the
// most-recently-mounted composer only — the modal stacks on top, so the
// modal wins when both are present, and the page takes over once the modal
// closes.
const composerDropStack: symbol[] = []
const EMPTY_SPARSE_PRESETS: SparsePreset[] = []

export function useComposerState(options: UseComposerStateOptions): UseComposerStateResult {
  const {
    initialRepoId,
    initialName = '',
    initialPrompt = '',
    initialLinkedWorkItem = null,
    initialBaseBranch,
    persistDraft,
    onCreated,
    repoIdOverride,
    onRepoIdOverrideChange,
    telemetrySource
  } = options

  // Why: each `useAppStore(s => s.someAction)` registers its own equality
  // check that React has to re-run on every store mutation. Consolidating
  // all stable actions into a single useShallow subscription turns 11 checks
  // per store update into one.
  const actions = useAppStore(
    useShallow((s) => ({
      setNewWorkspaceDraft: s.setNewWorkspaceDraft,
      clearNewWorkspaceDraft: s.clearNewWorkspaceDraft,
      createWorktree: s.createWorktree,
      updateWorktreeMeta: s.updateWorktreeMeta,
      setSidebarOpen: s.setSidebarOpen,
      setRightSidebarOpen: s.setRightSidebarOpen,
      setRightSidebarTab: s.setRightSidebarTab,
      closeModal: s.closeModal,
      openSettingsPage: s.openSettingsPage,
      openSettingsTarget: s.openSettingsTarget,
      prefetchWorkItems: s.prefetchWorkItems,
      fetchSparsePresets: s.fetchSparsePresets
    }))
  )
  const {
    setNewWorkspaceDraft,
    clearNewWorkspaceDraft,
    createWorktree,
    updateWorktreeMeta,
    setSidebarOpen,
    setRightSidebarOpen,
    setRightSidebarTab,
    closeModal,
    openSettingsPage,
    openSettingsTarget,
    prefetchWorkItems,
    fetchSparsePresets
  } = actions

  const repos = useAppStore((s) => s.repos)
  const activeRepoId = useAppStore((s) => s.activeRepoId)
  const settings = useAppStore((s) => s.settings)
  const newWorkspaceDraft = useAppStore((s) => s.newWorkspaceDraft)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const sparsePresetsByRepo = useAppStore((s) => s.sparsePresetsByRepo)
  const eligibleRepos = useMemo(() => repos.filter((repo) => isGitRepoKind(repo)), [repos])
  const draftRepoId = persistDraft ? (newWorkspaceDraft?.repoId ?? null) : null

  const resolvedInitialRepoId =
    draftRepoId && eligibleRepos.some((repo) => repo.id === draftRepoId)
      ? draftRepoId
      : initialRepoId && eligibleRepos.some((repo) => repo.id === initialRepoId)
        ? initialRepoId
        : activeRepoId && eligibleRepos.some((repo) => repo.id === activeRepoId)
          ? activeRepoId
          : (eligibleRepos[0]?.id ?? '')

  const [internalRepoId, setInternalRepoId] = useState<string>(resolvedInitialRepoId)
  const repoId = repoIdOverride ?? internalRepoId
  const setRepoId = useCallback(
    (value: string) => {
      if (onRepoIdOverrideChange) {
        onRepoIdOverrideChange(value)
      } else {
        setInternalRepoId(value)
      }
    },
    [onRepoIdOverrideChange]
  )

  const [name, setName] = useState<string>(
    persistDraft ? (newWorkspaceDraft?.name ?? initialName) : initialName
  )
  const [agentPrompt, setAgentPrompt] = useState<string>(
    persistDraft ? (newWorkspaceDraft?.prompt ?? initialPrompt) : initialPrompt
  )
  const [note, setNote] = useState<string>(persistDraft ? (newWorkspaceDraft?.note ?? '') : '')
  const [attachmentPaths, setAttachmentPaths] = useState<string[]>(
    persistDraft ? (newWorkspaceDraft?.attachments ?? []) : []
  )
  const [linkedWorkItem, setLinkedWorkItem] = useState<LinkedWorkItemSummary | null>(
    persistDraft
      ? (newWorkspaceDraft?.linkedWorkItem ?? initialLinkedWorkItem)
      : initialLinkedWorkItem
  )
  const [linkedIssue, setLinkedIssue] = useState<string>(() => {
    if (persistDraft && newWorkspaceDraft?.linkedIssue) {
      return newWorkspaceDraft.linkedIssue
    }
    if (initialLinkedWorkItem?.type === 'issue') {
      return String(initialLinkedWorkItem.number)
    }
    return ''
  })
  const [linkedPR, setLinkedPR] = useState<number | null>(() => {
    if (persistDraft && newWorkspaceDraft?.linkedPR !== undefined) {
      return newWorkspaceDraft.linkedPR
    }
    return initialLinkedWorkItem?.type === 'pr' ? initialLinkedWorkItem.number : null
  })
  const [baseBranch, setBaseBranch] = useState<string | undefined>(
    persistDraft ? newWorkspaceDraft?.baseBranch : initialBaseBranch
  )
  // Why: when a repo switch wipes a prior Start-from selection, surface the
  // reset inline (e.g. "was PR #8778") so the change is recoverable visually
  // instead of slipping past the user. Cleared on any subsequent selection.
  const [startFromResetHint, setStartFromResetHint] = useState<string | null>(null)
  // Why: the long-form composer's agent selection is a required TuiAgent (not
  // null/blank), so 'blank' preferences from global settings must collapse to
  // the Claude default here — the blank-terminal affordance only lives in the
  // quick-create flow.
  const fallbackDefaultAgent: TuiAgent =
    settings?.defaultTuiAgent && settings.defaultTuiAgent !== 'blank'
      ? settings.defaultTuiAgent
      : 'claude'
  const [tuiAgent, setTuiAgent] = useState<TuiAgent>(
    persistDraft ? (newWorkspaceDraft?.agent ?? fallbackDefaultAgent) : fallbackDefaultAgent
  )
  // Why: when the selected repo is remote (has a connectionId), read the
  // per-connection agent list instead of the local one. This ensures the
  // Create Workspace dialog shows agents installed on the SSH host, not the
  // local machine. Derived from eligibleRepos directly because selectedRepo
  // is declared later in this function.
  const connectionId = eligibleRepos.find((r) => r.id === repoId)?.connectionId ?? null
  const isRemote = typeof connectionId === 'string'
  const detectedAgentList = useAppStore((s) => {
    if (isRemote) {
      return s.remoteDetectedAgentIds[connectionId] ?? null
    }
    return s.detectedAgentIds
  })
  const ensureDetectedAgents = useAppStore((s) => s.ensureDetectedAgents)
  const ensureRemoteDetectedAgents = useAppStore((s) => s.ensureRemoteDetectedAgents)
  const detectedAgentIds = useMemo<Set<TuiAgent> | null>(
    () => (detectedAgentList ? new Set(detectedAgentList) : null),
    [detectedAgentList]
  )

  const [yamlHooks, setYamlHooks] = useState<OrcaHooks | null>(null)
  const [checkedHooksRepoId, setCheckedHooksRepoId] = useState<string | null>(null)
  const [issueCommandTemplate, setIssueCommandTemplate] = useState('')
  const [hasLoadedIssueCommand, setHasLoadedIssueCommand] = useState(false)
  const [setupDecision, setSetupDecision] = useState<'run' | 'skip' | null>(null)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
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

  const lastAutoNameRef = useRef<string>(
    persistDraft ? (newWorkspaceDraft?.name ?? initialName) : initialName
  )
  // Why: tracks the note value we auto-prefilled from a Start-from PR pick, so
  // a subsequent PR change can replace it without clobbering user-typed text.
  const lastAutoNoteRef = useRef<string>('')
  // Why: read the latest note inside handleBaseBranchPrSelect without adding
  // `note` to its deps (which would rebuild the callback on every keystroke).
  const noteRef = useRef<string>(note)
  useEffect(() => {
    noteRef.current = note
  }, [note])
  const composerRef = useRef<HTMLDivElement | null>(null)
  const promptTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const nameInputRef = useRef<HTMLInputElement | null>(null)
  // Why: the native-file-drop effect below subscribes once on mount and must
  // read the latest agentPrompt when computing the caret-scoped insertion.
  // Mirror the value into a ref so the listener sees fresh state without
  // re-subscribing (which would reorder the composerDropStack and break
  // multi-instance routing).
  const agentPromptRef = useRef(agentPrompt)
  agentPromptRef.current = agentPrompt

  const selectedRepo = eligibleRepos.find((repo) => repo.id === repoId)

  // Why: resolves the selected repo's owner/repo slug so a PR URL pasted
  // into the workspace name field can be matched against the current repo.
  // Pasting a PR URL from a different repo would otherwise recover only the
  // PR number, mislinking the worktree to an unrelated PR with the same
  // number in the selected repo.
  const [selectedRepoSlug, setSelectedRepoSlug] = useState<{ owner: string; repo: string } | null>(
    null
  )
  const selectedRepoPath = selectedRepo?.path
  useEffect(() => {
    if (!selectedRepoPath) {
      setSelectedRepoSlug(null)
      return
    }
    let cancelled = false
    void (
      window.api.gh.repoSlug({ repoPath: selectedRepoPath }) as Promise<{
        owner: string
        repo: string
      } | null>
    )
      .then((result) => {
        if (cancelled) {
          return
        }
        setSelectedRepoSlug(result)
      })
      .catch(() => {
        if (!cancelled) {
          setSelectedRepoSlug(null)
        }
      })
    return () => {
      cancelled = true
    }
  }, [selectedRepoPath])
  const sparsePresetsForRepo = sparsePresetsByRepo[repoId]
  const sparsePresets = sparsePresetsForRepo ?? EMPTY_SPARSE_PRESETS
  const normalizedSparseDirectories = useMemo(
    () => normalizeSparseDirectoryLines(sparseDirectories),
    [sparseDirectories]
  )
  // Why: a preset attribution should only ride along if what's about to be
  // created actually equals the saved preset. If the user picked a preset and
  // then edited the textarea, we want the worktree to be a "Custom" sparse
  // checkout — not falsely tagged as the original preset.
  const effectivePresetId = useMemo(() => {
    if (!sparseSelectedPresetId) {
      return null
    }
    const selected = sparsePresets.find((preset) => preset.id === sparseSelectedPresetId)
    if (!selected) {
      return null
    }
    return sparseDirectoriesMatch(selected.directories, normalizedSparseDirectories)
      ? selected.id
      : null
  }, [normalizedSparseDirectories, sparsePresets, sparseSelectedPresetId])

  const sparseError = useMemo(() => {
    if (!sparseEnabled) {
      return null
    }
    if (selectedRepo?.connectionId) {
      return 'Sparse checkout is only supported for local repos right now.'
    }
    if (normalizedSparseDirectories.length === 0) {
      return 'Enter at least one repo-relative directory.'
    }
    if (
      normalizedSparseDirectories.some((entry) => entry === '.' || entry.split('/').includes('..'))
    ) {
      return 'Use repo-relative directories, not root or parent paths.'
    }
    return null
  }, [normalizedSparseDirectories, selectedRepo?.connectionId, sparseEnabled])
  const parsedLinkedIssueNumber = useMemo(
    () => (linkedIssue.trim() ? parseGitHubIssueOrPRNumber(linkedIssue) : null),
    [linkedIssue]
  )
  // Why: when the user pastes a PR URL straight into the workspace name field
  // (without picking from the source picker), `linkedPR` stays null and the
  // worktree card has no PR strip. Recover the PR number from the name on
  // submit so create-from-PR worktrees always link back to their PR.
  const effectiveLinkedPR = useMemo<number | null>(() => {
    if (linkedPR !== null) {
      return linkedPR
    }
    const fromName = parseGitHubIssueOrPRLink(name)
    if (fromName && fromName.type === 'pr') {
      // Why: only adopt a number when the URL's owner/repo matches the
      // selected repo. Pasting `github.com/other/repo/pull/1234` must not
      // mislink the worktree to an unrelated PR #1234 in the current repo.
      // If the slug hasn't resolved yet, suppress recovery rather than
      // risking a cross-repo mislink.
      if (
        selectedRepoSlug &&
        fromName.slug.owner.toLowerCase() === selectedRepoSlug.owner.toLowerCase() &&
        fromName.slug.repo.toLowerCase() === selectedRepoSlug.repo.toLowerCase()
      ) {
        return fromName.number
      }
    }
    return null
  }, [linkedPR, name, selectedRepoSlug])
  const setupConfig = useMemo(
    () => getSetupConfig(selectedRepo, yamlHooks),
    [selectedRepo, yamlHooks]
  )
  const setupPolicy: SetupRunPolicy = selectedRepo?.hookSettings?.setupRunPolicy ?? 'run-by-default'
  const hasIssueAutomationConfig = issueCommandTemplate.length > 0
  const canOfferIssueAutomation = parsedLinkedIssueNumber !== null && hasIssueAutomationConfig
  // Why: the "no prompt + linked item" path below rehydrates the issueCommand
  // template into the main startup prompt. When that happens we suppress the
  // separate split pane that would otherwise run the same command twice.
  const willApplyIssueCommandAsPrompt = !agentPrompt.trim() && Boolean(linkedWorkItem)
  const shouldWaitForIssueAutomationCheck =
    (parsedLinkedIssueNumber !== null || willApplyIssueCommandAsPrompt) && !hasLoadedIssueCommand
  const shouldRunIssueAutomation = canOfferIssueAutomation && !willApplyIssueCommandAsPrompt
  const requiresExplicitSetupChoice = Boolean(setupConfig) && setupPolicy === 'ask'
  const resolvedSetupDecision =
    setupDecision ??
    (!setupConfig || setupPolicy === 'ask'
      ? null
      : setupPolicy === 'run-by-default'
        ? 'run'
        : 'skip')
  const isSetupCheckPending = Boolean(repoId) && checkedHooksRepoId !== repoId
  const shouldWaitForSetupCheck = Boolean(selectedRepo) && isSetupCheckPending

  // Why: when the user leaves the workspace name blank and provides no other
  // seed source (prompt, linked issue/PR), pick a repo-scoped unique marine
  // creature name so the workspace gets a distinct, readable identifier
  // instead of colliding on a literal "workspace" default.
  const fallbackCreatureName = useMemo(
    () => getSuggestedCreatureName(repoId, worktreesByRepo, settings?.nestWorkspaces ?? true),
    [repoId, worktreesByRepo, settings?.nestWorkspaces]
  )
  const workspaceSeedName = useMemo(
    () =>
      getWorkspaceSeedName({
        explicitName: name,
        prompt: agentPrompt,
        linkedIssueNumber: parsedLinkedIssueNumber,
        linkedPR,
        fallbackName: fallbackCreatureName
      }),
    [agentPrompt, fallbackCreatureName, linkedPR, name, parsedLinkedIssueNumber]
  )
  // Why: when the user links an issue/PR but has not typed any prompt text
  // (attachments don't count), swap the generic "Linked work items:" context
  // block for the repo's issueCommand template — or the built-in
  // "Complete {{artifact_url}}" default when none is configured. This makes
  // the common "paste a link and hit enter" flow produce a useful agent task
  // instead of a bare URL bullet.
  const shouldApplyLinkedOnlyTemplate =
    !agentPrompt.trim() && Boolean(linkedWorkItem) && hasLoadedIssueCommand
  const linkedOnlyTemplatePrompt = useMemo(() => {
    if (!shouldApplyLinkedOnlyTemplate || !linkedWorkItem) {
      return ''
    }
    const template = issueCommandTemplate.trim() || DEFAULT_ISSUE_COMMAND_TEMPLATE
    return renderIssueCommandTemplate(template, {
      issueNumber: linkedWorkItem.type === 'issue' ? linkedWorkItem.number : null,
      artifactUrl: linkedWorkItem.url
    })
  }, [issueCommandTemplate, linkedWorkItem, shouldApplyLinkedOnlyTemplate])
  const startupPrompt = useMemo(() => {
    if (shouldApplyLinkedOnlyTemplate) {
      return buildAgentPromptWithContext(linkedOnlyTemplatePrompt, attachmentPaths, [])
    }
    return buildAgentPromptWithContext(
      agentPrompt,
      attachmentPaths,
      linkedWorkItem?.url ? [linkedWorkItem.url] : []
    )
  }, [
    agentPrompt,
    attachmentPaths,
    linkedOnlyTemplatePrompt,
    linkedWorkItem?.url,
    shouldApplyLinkedOnlyTemplate
  ])
  const normalizedLinkQuery = useMemo(
    () => normalizeGitHubLinkQuery(linkDebouncedQuery),
    [linkDebouncedQuery]
  )

  const filteredLinkItems = useMemo(() => {
    if (normalizedLinkQuery.directNumber !== null) {
      return linkDirectItem ? [linkDirectItem] : []
    }

    const query = normalizedLinkQuery.query.trim().toLowerCase()
    if (!query) {
      return linkItems
    }

    return linkItems.filter((item) => {
      const text = [
        item.type,
        item.number,
        item.title,
        item.author ?? '',
        item.labels.join(' '),
        item.branchName ?? '',
        item.baseRefName ?? ''
      ]
        .join(' ')
        .toLowerCase()
      return text.includes(query)
    })
  }, [linkDirectItem, linkItems, normalizedLinkQuery.directNumber, normalizedLinkQuery.query])

  // Persist draft whenever relevant fields change (full-page only).
  useEffect(() => {
    if (!persistDraft) {
      return
    }
    setNewWorkspaceDraft({
      repoId: repoId || null,
      name,
      prompt: agentPrompt,
      note,
      attachments: attachmentPaths,
      linkedWorkItem,
      agent: tuiAgent,
      linkedIssue,
      linkedPR,
      ...(baseBranch !== undefined ? { baseBranch } : {})
    })
  }, [
    persistDraft,
    agentPrompt,
    attachmentPaths,
    baseBranch,
    linkedIssue,
    linkedPR,
    linkedWorkItem,
    note,
    name,
    repoId,
    setNewWorkspaceDraft,
    tuiAgent
  ])

  // Auto-pick the first eligible repo if we somehow start with none selected.
  useEffect(() => {
    if (!repoId && eligibleRepos[0]?.id) {
      setRepoId(eligibleRepos[0].id)
    }
  }, [eligibleRepos, repoId, setRepoId])

  // Why: the compact sparse dropdown is always visible under Advanced, so
  // presets must load before sparse mode is enabled.
  useEffect(() => {
    if (!repoId || selectedRepo?.connectionId) {
      return
    }
    if (sparsePresetsByRepo[repoId] !== undefined) {
      return
    }
    void fetchSparsePresets(repoId)
  }, [fetchSparsePresets, repoId, selectedRepo?.connectionId, sparsePresetsByRepo])

  // Why: detect agents for the selected repo. For local repos this runs once
  // on mount (deduped by the store). For remote repos it re-runs when the
  // selected repo changes so the agent list matches the SSH host.
  useEffect(() => {
    let cancelled = false
    const detect = isRemote ? ensureRemoteDetectedAgents(connectionId) : ensureDetectedAgents()
    void detect.then((ids) => {
      if (cancelled) {
        return
      }
      if (!newWorkspaceDraft?.agent && !settings?.defaultTuiAgent && ids.length > 0) {
        const firstInCatalogOrder = AGENT_CATALOG.find((a) => ids.includes(a.id))
        if (firstInCatalogOrder) {
          setTuiAgent(firstInCatalogOrder.id)
        }
      }
    })
    return () => {
      cancelled = true
    }
    // Why: re-run when connectionId changes (user picks a different repo) so
    // detection targets the correct host. Draft/settings deps are intentionally
    // excluded — detection is a best-effort PATH snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, isRemote])

  // Per-repo: load yaml hooks + issue command template.
  useEffect(() => {
    if (!repoId) {
      return
    }

    let cancelled = false
    setHasLoadedIssueCommand(false)
    setIssueCommandTemplate('')
    setYamlHooks(null)
    setCheckedHooksRepoId(null)

    void window.api.hooks
      .check({ repoId })
      .then((result) => {
        if (!cancelled) {
          setYamlHooks(result.hooks)
          setCheckedHooksRepoId(repoId)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setYamlHooks(null)
          setCheckedHooksRepoId(repoId)
        }
      })

    void window.api.hooks
      .readIssueCommand({ repoId })
      .then((result) => {
        if (!cancelled) {
          setIssueCommandTemplate(result.effectiveContent ?? '')
          setHasLoadedIssueCommand(true)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setIssueCommandTemplate('')
          setHasLoadedIssueCommand(true)
        }
      })

    return () => {
      cancelled = true
    }
  }, [repoId])

  // Why: warm the Start-from picker's PR cache on composer mount and whenever
  // the selected repo changes so opening the picker paints instantly from
  // cache. Local repos only — remote SSH repos disable the PR tab in v1.
  useEffect(() => {
    if (!selectedRepo?.path || selectedRepo.connectionId) {
      return
    }
    prefetchWorkItems(selectedRepo.id, selectedRepo.path, PER_REPO_FETCH_LIMIT, 'is:pr is:open')
  }, [prefetchWorkItems, selectedRepo?.connectionId, selectedRepo?.id, selectedRepo?.path])

  // Reset setup decision when config / policy changes.
  useEffect(() => {
    if (shouldWaitForSetupCheck) {
      setSetupDecision(null)
      return
    }
    if (!setupConfig) {
      setSetupDecision(null)
      return
    }
    if (setupPolicy === 'ask') {
      setSetupDecision(null)
      return
    }
    setSetupDecision(setupPolicy === 'run-by-default' ? 'run' : 'skip')
  }, [setupConfig, setupPolicy, shouldWaitForSetupCheck])

  // Link popover: debounce + load recent items + resolve direct number.
  useEffect(() => {
    const timeout = window.setTimeout(() => setLinkDebouncedQuery(linkQuery), 250)
    return () => window.clearTimeout(timeout)
  }, [linkQuery])

  useEffect(() => {
    if (!linkPopoverOpen || !selectedRepo) {
      return
    }

    let cancelled = false
    setLinkItemsLoading(true)

    const lookupRepoId = selectedRepo.id
    void window.api.gh
      .listWorkItems({ repoPath: selectedRepo.path, limit: 100 })
      .then((envelope) => {
        if (!cancelled) {
          // Why: IPC payload omits repoId — stamp it here from the repo we
          // queried so downstream consumers typed against GitHubWorkItem work.
          // Cast through unknown: spreading a discriminated union loses the
          // discriminant, so the union-preserving shape must be asserted.
          // Why: the link popover intentionally does NOT surface
          // `envelope.errors?.issues`. Per-surface error copy lives in the
          // Tasks view (TaskPage) and the smart workspace-name field — a
          // partial-failure banner inside the small
          // @-mention popover would crowd the input and the user would
          // already see the same error on the originating Tasks page. If a
          // future UX decision flips this, add an error row to the popover's
          // render output.
          // Why: surface partial issues-side failures via devtools even though the
          // popover intentionally omits a UI banner (see rationale above). A user
          // hitting a 403 on a private upstream would otherwise see an empty popover
          // and no diagnostic trail.
          if (envelope.errors?.issues) {
            console.warn(
              '[composer/link] issues-side partial failure in @-mention popover:',
              envelope.errors.issues
            )
          }
          setLinkItems(
            envelope.items.map((it) => ({
              ...it,
              repoId: lookupRepoId
            })) as unknown as GitHubWorkItem[]
          )
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLinkItems([])
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLinkItemsLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [linkPopoverOpen, selectedRepo])

  useEffect(() => {
    if (!linkPopoverOpen || !selectedRepo || normalizedLinkQuery.directNumber === null) {
      setLinkDirectItem(null)
      setLinkDirectLoading(false)
      return
    }

    let cancelled = false
    setLinkDirectLoading(true)
    // Why: Superset lets users paste a full GitHub URL or type a raw issue/PR
    // number and still get a concrete selectable result. Orca mirrors that by
    // resolving direct lookups against the selected repo instead of requiring a
    // text match in the recent-items list.
    const lookupRepoId = selectedRepo.id
    void window.api.gh
      .workItem({ repoPath: selectedRepo.path, number: normalizedLinkQuery.directNumber })
      .then((item) => {
        if (!cancelled) {
          setLinkDirectItem(
            item ? ({ ...item, repoId: lookupRepoId } as unknown as GitHubWorkItem) : null
          )
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLinkDirectItem(null)
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLinkDirectLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [linkPopoverOpen, normalizedLinkQuery.directNumber, selectedRepo])

  const applyLinkedWorkItem = useCallback(
    (item: GitHubWorkItem): void => {
      if (item.type === 'issue') {
        setLinkedIssue(String(item.number))
        setLinkedPR(null)
      } else {
        setLinkedIssue('')
        setLinkedPR(item.number)
      }
      setLinkedWorkItem({
        type: item.type,
        number: item.number,
        title: item.title,
        url: item.url
      })
      const suggestedName = getLinkedWorkItemSuggestedName(item)
      if (suggestedName && (!name.trim() || name === lastAutoNameRef.current)) {
        setName(suggestedName)
        lastAutoNameRef.current = suggestedName
      }
    },
    [name]
  )

  const handleSelectLinkedItem = useCallback(
    (item: GitHubWorkItem): void => {
      applyLinkedWorkItem(item)
      setLinkPopoverOpen(false)
      setLinkQuery('')
      setLinkDebouncedQuery('')
      setLinkDirectItem(null)
    },
    [applyLinkedWorkItem]
  )

  const handleLinkPopoverChange = useCallback((open: boolean): void => {
    setLinkPopoverOpen(open)
    if (!open) {
      setLinkQuery('')
      setLinkDebouncedQuery('')
      setLinkDirectItem(null)
    }
  }, [])

  const handleRemoveLinkedWorkItem = useCallback((): void => {
    setLinkedWorkItem(null)
    setLinkedIssue('')
    setLinkedPR(null)
    if (name === lastAutoNameRef.current) {
      lastAutoNameRef.current = ''
    }
  }, [name])

  const handleNameValueChange = useCallback(
    (nextName: string): void => {
      // Why: linked GitHub items should keep refreshing the suggested workspace
      // name only while the current value is still auto-managed. As soon as the
      // user edits the field by hand, later issue/PR selections must stop
      // clobbering it until they clear the field again.
      if (!nextName.trim()) {
        lastAutoNameRef.current = ''
      } else if (name !== lastAutoNameRef.current) {
        lastAutoNameRef.current = ''
      }
      setName(nextName)
      setCreateError(null)
    },
    [name]
  )
  const handleAddAttachment = useCallback(async (): Promise<void> => {
    try {
      const selectedPath = await window.api.shell.pickAttachment()
      if (!selectedPath) {
        return
      }
      setAttachmentPaths((current) => {
        if (current.includes(selectedPath)) {
          return current
        }
        return [...current, selectedPath]
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to add attachment.'
      toast.error(message)
    }
  }, [])

  // Why: native OS file drops onto the composer are captured by the preload
  // bridge (see `data-native-file-drop-target="composer"` markers) and relayed
  // as a gesture-scoped IPC event. Files become attachments (matching the
  // manual picker behavior); folders are pasted inline at the textarea caret
  // so the user can reference them as working directories in their prompt
  // without attaching a path we can't embed as file content.
  const instanceIdRef = useRef<symbol>(Symbol('composer'))
  useEffect(() => {
    const instanceId = instanceIdRef.current
    composerDropStack.push(instanceId)
    const unsubscribe = window.api.ui.onFileDrop((data) => {
      if (data.target !== 'composer') {
        return
      }
      // Why: only the top-of-stack composer (most recently mounted) owns the
      // drop. Earlier subscribers stay bound to keep their own cleanup tidy
      // but short-circuit so the event doesn't double-apply when page+modal
      // are both alive.
      if (composerDropStack.at(-1) !== instanceId) {
        return
      }
      void (async () => {
        const fileAttachments: string[] = []
        const folderPaths: string[] = []
        for (const filePath of data.paths) {
          try {
            await window.api.fs.authorizeExternalPath({ targetPath: filePath })
            const stat = await window.api.fs.stat({ filePath })
            if (stat.isDirectory) {
              folderPaths.push(filePath)
            } else {
              fileAttachments.push(filePath)
            }
          } catch {
            // Skip paths we cannot authorize or stat.
          }
        }

        if (fileAttachments.length > 0) {
          setAttachmentPaths((current) => {
            const next = [...current]
            for (const p of fileAttachments) {
              if (!next.includes(p)) {
                next.push(p)
              }
            }
            return next
          })
        }

        if (folderPaths.length > 0) {
          // Why: de-dup within a single drop — the OS occasionally delivers
          // the same folder twice when a user drags from a selection that
          // includes both the item and its parent, and we don't want to
          // insert it multiple times.
          const uniqueFolderPaths = Array.from(new Set(folderPaths))
          // Why: wrap paths containing shell metacharacters in double quotes
          // (and escape embedded quotes) so the inserted text reads as a
          // single token if the user pastes it into a terminal. Simple paths
          // stay unadorned to match how Finder/Explorer drops appear.
          const formatPath = (p: string): string => {
            if (/[\s"'$`\\()[\]{}*?!;&|<>#~]/.test(p)) {
              return `"${p.replace(/(["\\$`])/g, '\\$1')}"`
            }
            return p
          }
          const insertion = uniqueFolderPaths.map(formatPath).join(' ')
          const textarea = promptTextareaRef.current
          // Why: compute selection, insertion, and caret target OUTSIDE the
          // setAgentPrompt updater so the updater stays pure. React Strict
          // Mode double-invokes updaters in dev, and batching can delay
          // execution — reading `textarea.selectionStart` inside the updater
          // risks seeing a shifted caret. Read `agentPromptRef.current` for
          // the latest prompt because this effect subscribes once and the
          // outer closure's `agentPrompt` would be stale.
          const current = agentPromptRef.current
          const selStart = textarea?.selectionStart ?? current.length
          const selEnd = textarea?.selectionEnd ?? current.length
          const before = current.slice(0, selStart)
          const after = current.slice(selEnd)
          // Why: pad with single spaces when the caret sits directly against
          // other text so the folder path doesn't merge into an adjacent word.
          const needsLeadingSpace = before.length > 0 && !/\s$/.test(before)
          const needsTrailingSpace = after.length > 0 && !/^\s/.test(after)
          const padded = `${needsLeadingSpace ? ' ' : ''}${insertion}${needsTrailingSpace ? ' ' : ''}`
          const caret = before.length + padded.length
          if (textarea) {
            // Restore the caret to the end of the inserted text after React flushes.
            requestAnimationFrame(() => {
              textarea.focus()
              textarea.setSelectionRange(caret, caret)
            })
          }
          // Why: pass a plain value (not an updater) since `before`/`after`
          // were already resolved from `agentPromptRef.current`; this keeps
          // the state write side-effect-free under Strict-Mode double-render.
          setAgentPrompt(before + padded + after)
        }
      })()
    })
    return () => {
      unsubscribe()
      const idx = composerDropStack.lastIndexOf(instanceId)
      if (idx !== -1) {
        composerDropStack.splice(idx, 1)
      }
    }
  }, [])

  const handlePromptKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
      const mod = IS_MAC ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
      if (!mod || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'u') {
        return
      }

      // Why: the attachment picker should only steal Cmd/Ctrl+U while the user
      // is composing a prompt, so the shortcut is scoped to the textarea rather
      // than registered globally for the whole new-workspace surface.
      event.preventDefault()
      void handleAddAttachment()
    },
    [handleAddAttachment]
  )

  const handleRepoChange = useCallback(
    (value: string): void => {
      if (value === repoId) {
        setRepoId(value)
        return
      }
      // Why: capture a short descriptor of the prior Start-from selection so
      // the field can render an inline reset (e.g. "was PR #8778") after the
      // repo changes and the selection is wiped.
      let hint: string | null = null
      if (linkedWorkItem?.type === 'pr' && baseBranch) {
        hint = `was PR #${linkedWorkItem.number}`
      } else if (baseBranch) {
        hint = `was ${baseBranch}`
      }
      setRepoId(value)
      setLinkedIssue('')
      setLinkedPR(null)
      setLinkedWorkItem(null)
      setSparseEnabled(false)
      setSparseDirectories('')
      // Why: presets are repo-scoped, so a stale selection from the prior
      // repo would be meaningless after a repo switch.
      setSparseSelectedPresetId(null)
      // Why: the Start-from picker is repo-scoped, so any prior branch/PR
      // selection is meaningless in the new repo. Resetting to undefined
      // makes the field fall back to the new repo's effective base ref.
      setBaseBranch(undefined)
      setStartFromResetHint(hint)
    },
    [baseBranch, linkedWorkItem, repoId, setRepoId]
  )

  const handleSparseSelectPreset = useCallback((preset: SparsePreset | null): void => {
    if (preset) {
      setSparseEnabled(true)
      setSparseDirectories(preset.directories.join('\n'))
      setSparseSelectedPresetId(preset.id)
    } else {
      setSparseEnabled(false)
      setSparseDirectories('')
      setSparseSelectedPresetId(null)
    }
  }, [])

  const handleBaseBranchChange = useCallback((next: string | undefined): void => {
    setBaseBranch(next)
    setStartFromResetHint(null)
  }, [])

  const handleBaseBranchPrSelect = useCallback(
    (nextBaseBranch: string, item: GitHubWorkItem): void => {
      setBaseBranch(nextBaseBranch)
      setStartFromResetHint(null)
      // Why: per spec, a PR selection in the Start-from picker is also a
      // linkedWorkItem assignment. Reuse applyLinkedWorkItem so auto-name and
      // linkedPR state stay in a single code path.
      applyLinkedWorkItem(item)
      // Why: starting a worktree from a PR is a strong hint for what the
      // worktree's comment should surface (`orca worktree current`, sidebar).
      // Prefill the note if it's empty or still equal to a prior auto-fill, so
      // we don't overwrite anything the user has typed.
      if (item.type === 'pr') {
        const suggestedNote = `PR #${item.number} — ${item.title}`
        const currentNote = noteRef.current
        if (!currentNote.trim() || currentNote === lastAutoNoteRef.current) {
          setNote(suggestedNote)
          lastAutoNoteRef.current = suggestedNote
        }
      }
    },
    [applyLinkedWorkItem]
  )

  const handleSmartGitHubItemSelect = useCallback(
    (item: GitHubWorkItem): void => {
      applyLinkedWorkItem(item)
      setStartFromResetHint(null)
      const repoForItem = eligibleRepos.find((repo) => repo.id === item.repoId) ?? selectedRepo
      if (item.type !== 'pr' || !repoForItem) {
        return
      }
      void window.api.worktrees
        .resolvePrBase({
          repoId: repoForItem.id,
          prNumber: item.number,
          ...(item.branchName ? { headRefName: item.branchName } : {}),
          ...(item.isCrossRepository !== undefined
            ? { isCrossRepository: item.isCrossRepository }
            : {})
        })
        .then((result) => {
          if ('error' in result) {
            return
          }
          handleBaseBranchPrSelect(result.baseBranch, item)
        })
    },
    [applyLinkedWorkItem, eligibleRepos, handleBaseBranchPrSelect, selectedRepo]
  )

  const handleSmartBranchSelect = useCallback(
    (refName: string): void => {
      setBaseBranch(refName)
      setStartFromResetHint(null)
      if (!name.trim() || name === lastAutoNameRef.current) {
        setName(refName)
        lastAutoNameRef.current = refName
      }
    },
    [name]
  )

  const handleSmartLinearIssueSelect = useCallback(
    (issue: LinearIssue): void => {
      setLinkedIssue('')
      setLinkedPR(null)
      setLinkedWorkItem({
        type: 'issue',
        // Why: Linear identifiers are strings (e.g. ENG-123); keep GitHub
        // numeric metadata empty and carry the real source through the URL.
        number: 0,
        title: issue.title,
        url: issue.url
      })
      const suggestedName = issue.title
      if (!name.trim() || name === lastAutoNameRef.current) {
        setName(suggestedName)
        lastAutoNameRef.current = suggestedName
      }
      // Why: match the GitHub issue/PR flow — paste only the URL as a draft
      // into the agent's input (no auto-submit). The launch path already
      // drafts `linkedWorkItem.url` when the note is empty; auto-filling the
      // note here would flip Linear into the `isLinearTypedOnly` branch and
      // auto-submit the full details block.
    },
    [name]
  )

  const handleClearSmartNameSelection = useCallback((): void => {
    setLinkedIssue('')
    setLinkedPR(null)
    setLinkedWorkItem(null)
    setBaseBranch(undefined)
    setStartFromResetHint(null)
    if (name === lastAutoNameRef.current) {
      setName('')
      lastAutoNameRef.current = ''
    }
    if (noteRef.current === lastAutoNoteRef.current) {
      setNote('')
      lastAutoNoteRef.current = ''
    }
  }, [name])

  const smartNameSelection = useMemo<SmartWorkspaceNameSelection | null>(() => {
    if (linkedWorkItem) {
      const isLinear = linkedWorkItem.number === 0 && !linkedWorkItem.url.includes('github.com')
      const kind: SmartWorkspaceNameSelection['kind'] = isLinear
        ? 'linear'
        : linkedWorkItem.type === 'pr'
          ? 'github-pr'
          : 'github-issue'
      return {
        kind,
        label:
          isLinear || linkedWorkItem.number === 0
            ? linkedWorkItem.title
            : `#${linkedWorkItem.number} ${linkedWorkItem.title}`,
        url: linkedWorkItem.url
      }
    }
    if (baseBranch) {
      return { kind: 'branch', label: baseBranch }
    }
    return null
  }, [baseBranch, linkedWorkItem])

  const handleOpenAgentSettings = useCallback((): void => {
    openSettingsTarget({ pane: 'agents', repoId: null })
    openSettingsPage()
    closeModal()
  }, [closeModal, openSettingsPage, openSettingsTarget])

  const applyWorktreeMeta = useCallback(
    async (
      worktreeId: string,
      meta: {
        linkedIssue?: number
        linkedPR?: number
        comment?: string
      }
    ): Promise<void> => {
      if (Object.keys(meta).length === 0) {
        return
      }
      try {
        await updateWorktreeMeta(worktreeId, meta)
      } catch {
        console.error('Failed to update worktree meta after creation')
      }
    },
    [updateWorktreeMeta]
  )

  const submit = useCallback(async (): Promise<void> => {
    const workspaceName = workspaceSeedName
    if (
      !repoId ||
      !workspaceName ||
      !selectedRepo ||
      shouldWaitForSetupCheck ||
      shouldWaitForIssueAutomationCheck ||
      (requiresExplicitSetupChoice && !setupDecision) ||
      sparseError !== null
    ) {
      return
    }

    setCreateError(null)
    setCreating(true)
    try {
      const setupTrustDecision = await ensureHooksConfirmed(useAppStore.getState(), repoId, 'setup')
      const effectiveSetupDecision: SetupDecision =
        setupTrustDecision === 'skip'
          ? 'skip'
          : ((resolvedSetupDecision ?? 'inherit') as SetupDecision)

      let issueCommandTrustDecision: 'run' | 'skip' = 'run'
      if (shouldRunIssueAutomation) {
        issueCommandTrustDecision =
          setupTrustDecision === 'skip'
            ? 'skip'
            : await ensureHooksConfirmed(useAppStore.getState(), repoId, 'issueCommand')
      }

      const result = await createWorktree(
        repoId,
        workspaceName,
        baseBranch,
        effectiveSetupDecision,
        sparseEnabled
          ? {
              directories: normalizedSparseDirectories,
              ...(effectivePresetId ? { presetId: effectivePresetId } : {})
            }
          : undefined,
        telemetrySource
      )
      const worktree = result.worktree

      await applyWorktreeMeta(worktree.id, {
        ...(parsedLinkedIssueNumber !== null ? { linkedIssue: parsedLinkedIssueNumber } : {}),
        ...(effectiveLinkedPR !== null ? { linkedPR: effectiveLinkedPR } : {}),
        ...(note.trim() ? { comment: note.trim() } : {})
      })

      const issueCommand =
        shouldRunIssueAutomation && issueCommandTrustDecision === 'run'
          ? {
              command: renderIssueCommandTemplate(issueCommandTemplate, {
                issueNumber: parsedLinkedIssueNumber,
                artifactUrl: linkedWorkItem?.url ?? null
              })
            }
          : undefined
      const startupPlan = buildAgentStartupPlan({
        agent: tuiAgent,
        prompt: startupPrompt,
        cmdOverrides: settings?.agentCmdOverrides ?? {},
        platform: CLIENT_PLATFORM
      })

      // Why: thread agent_started telemetry through the queued startup so
      // main fires the event after the spawn succeeds. The composer
      // "create" path is the new-workspace surface; request_kind is
      // `'new'` because this is always a fresh session (issue/PR-driven
      // follow-ups go through launch-work-item-direct.ts).
      // Why: when the composer is opened from onboarding, the first
      // `agent_started` must attribute to `onboarding` so D1 activation
      // can be measured against the funnel.
      const composerTelemetry: AgentStartedTelemetry = {
        agent_kind: tuiAgentToAgentKind(tuiAgent),
        launch_source: telemetrySource === 'onboarding' ? 'onboarding' : 'new_workspace_composer',
        request_kind: 'new'
      }
      activateAndRevealWorktree(worktree.id, {
        setup: result.setup,
        issueCommand,
        ...(startupPlan
          ? {
              startup: {
                command: startupPlan.launchCommand,
                telemetry: composerTelemetry
              }
            }
          : {})
      })
      if (startupPlan) {
        void ensureAgentStartupInTerminal({
          worktreeId: worktree.id,
          startup: startupPlan
        })
      }
      setSidebarOpen(true)
      if (settings?.rightSidebarOpenByDefault) {
        setRightSidebarTab('explorer')
        setRightSidebarOpen(true)
      }
      if (persistDraft) {
        clearNewWorkspaceDraft()
      }
      onCreated?.()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create worktree.'
      setCreateError(message)
      toast.error(message)
    } finally {
      setCreating(false)
    }
  }, [
    baseBranch,
    clearNewWorkspaceDraft,
    createWorktree,
    applyWorktreeMeta,
    issueCommandTemplate,
    effectiveLinkedPR,
    linkedWorkItem?.url,
    normalizedSparseDirectories,
    note,
    onCreated,
    parsedLinkedIssueNumber,
    persistDraft,
    repoId,
    requiresExplicitSetupChoice,
    resolvedSetupDecision,
    selectedRepo,
    settings?.agentCmdOverrides,
    settings?.rightSidebarOpenByDefault,
    setRightSidebarOpen,
    setRightSidebarTab,
    setSidebarOpen,
    setupDecision,
    sparseEnabled,
    sparseError,
    effectivePresetId,
    telemetrySource,
    tuiAgent,
    shouldRunIssueAutomation,
    shouldWaitForIssueAutomationCheck,
    shouldWaitForSetupCheck,
    startupPrompt,
    workspaceSeedName
  ])

  const submitQuick = useCallback(
    async (agent: TuiAgent | null): Promise<void> => {
      const workspaceName = getWorkspaceSeedName({
        explicitName: name,
        prompt: '',
        linkedIssueNumber: parsedLinkedIssueNumber,
        linkedPR,
        fallbackName: fallbackCreatureName
      })
      if (
        !repoId ||
        !workspaceName ||
        !selectedRepo ||
        shouldWaitForSetupCheck ||
        (requiresExplicitSetupChoice && !setupDecision) ||
        sparseError !== null
      ) {
        return
      }

      setCreateError(null)
      setCreating(true)
      try {
        const trustDecision = await ensureHooksConfirmed(useAppStore.getState(), repoId, 'setup')
        const effectiveSetupDecision: SetupDecision =
          trustDecision === 'skip'
            ? 'skip'
            : ((resolvedSetupDecision ?? 'inherit') as SetupDecision)

        const result = await createWorktree(
          repoId,
          workspaceName,
          baseBranch,
          effectiveSetupDecision,
          sparseEnabled
            ? {
                directories: normalizedSparseDirectories,
                ...(effectivePresetId ? { presetId: effectivePresetId } : {})
              }
            : undefined,
          telemetrySource
        )
        const worktree = result.worktree

        const trimmedNote = note.trim()
        await applyWorktreeMeta(worktree.id, {
          ...(parsedLinkedIssueNumber !== null ? { linkedIssue: parsedLinkedIssueNumber } : {}),
          ...(effectiveLinkedPR !== null ? { linkedPR: effectiveLinkedPR } : {}),
          ...(trimmedNote ? { comment: trimmedNote } : {})
        })

        // Why: when a linked work item is selected in the quick flow, launch
        // the agent with a blank prompt and type the URL into its input as a
        // draft (no trailing Enter). This lets the user review/edit before
        // sending instead of auto-executing a "Complete <url>" template.
        // Falls back to the trimmed note when the linked item carries no
        // number/URL (Linear typed-only entries).
        const isLinearTypedOnly = linkedWorkItem?.number === 0 && Boolean(trimmedNote)
        const quickPrompt = isLinearTypedOnly && trimmedNote ? trimmedNote : ''
        const quickDraftPrompt = linkedWorkItem && !isLinearTypedOnly ? linkedWorkItem.url : null

        // Why: agents that gate first-launch behind a "Do you trust this
        // folder?" menu (cursor-agent, copilot) consume the bracketed paste
        // as menu input. Pre-write the trust artifact so the menu is
        // skipped — best-effort, errors swallowed by main. Guard the IPC
        // presence so a stale preload bundle doesn't crash the launch with
        // "Cannot read properties of undefined".
        if (agent && worktree.path && window.api.agentTrust?.markTrusted) {
          const preflight = TUI_AGENT_CONFIG[agent].preflightTrust
          if (preflight) {
            try {
              await window.api.agentTrust.markTrusted({
                preset: preflight,
                workspacePath: worktree.path
              })
            } catch {
              // Best-effort: continue with launch.
            }
          }
        }

        // Why: prefer the agent's native prefill flag (currently Claude's
        // `--prefill`) when it has one — sidesteps the readiness/paste race
        // entirely. Falls through to the type-after-ready path for every
        // other agent.
        const draftLaunchPlan =
          agent === null || !quickDraftPrompt
            ? null
            : buildAgentDraftLaunchPlan({
                agent,
                draft: quickDraftPrompt,
                cmdOverrides: settings?.agentCmdOverrides ?? {},
                platform: CLIENT_PLATFORM,
                windowsShell: settings?.terminalWindowsShell
              })

        let startupPlan: ReturnType<typeof buildAgentStartupPlan> = null
        if (draftLaunchPlan) {
          startupPlan = {
            agent: draftLaunchPlan.agent,
            launchCommand: draftLaunchPlan.launchCommand,
            expectedProcess: draftLaunchPlan.expectedProcess,
            followupPrompt: null,
            ...(draftLaunchPlan.env ? { env: draftLaunchPlan.env } : {})
          }
        } else if (agent !== null) {
          startupPlan = buildAgentStartupPlan({
            agent,
            prompt: quickPrompt,
            cmdOverrides: settings?.agentCmdOverrides ?? {},
            platform: CLIENT_PLATFORM,
            allowEmptyPromptLaunch: true
          })
          if (startupPlan && quickDraftPrompt) {
            startupPlan.draftPrompt = quickDraftPrompt
          }
        }

        // Why: only attach telemetry when an agent was selected — the
        // quick path also handles "blank shell" (agent === null) where no
        // agent_started event should fire. When telemetry is present main
        // emits the event after pty:spawn succeeds.
        const quickTelemetry: AgentStartedTelemetry | null =
          agent === null
            ? null
            : {
                agent_kind: tuiAgentToAgentKind(agent),
                launch_source:
                  telemetrySource === 'onboarding' ? 'onboarding' : 'new_workspace_composer',
                request_kind: 'new'
              }
        activateAndRevealWorktree(worktree.id, {
          setup: result.setup,
          ...(startupPlan
            ? {
                startup: {
                  command: startupPlan.launchCommand,
                  ...(startupPlan.env ? { env: startupPlan.env } : {}),
                  ...(quickTelemetry ? { telemetry: quickTelemetry } : {})
                }
              }
            : {})
        })
        if (startupPlan) {
          void ensureAgentStartupInTerminal({
            worktreeId: worktree.id,
            startup: startupPlan
          })
        }
        setSidebarOpen(true)
        if (settings?.rightSidebarOpenByDefault) {
          setRightSidebarTab('explorer')
          setRightSidebarOpen(true)
        }
        if (persistDraft) {
          clearNewWorkspaceDraft()
        }
        onCreated?.()
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to create worktree.'
        setCreateError(message)
        toast.error(message)
      } finally {
        setCreating(false)
      }
    },
    [
      applyWorktreeMeta,
      baseBranch,
      clearNewWorkspaceDraft,
      createWorktree,
      fallbackCreatureName,
      effectiveLinkedPR,
      linkedPR,
      linkedWorkItem,
      name,
      normalizedSparseDirectories,
      note,
      onCreated,
      parsedLinkedIssueNumber,
      persistDraft,
      repoId,
      requiresExplicitSetupChoice,
      resolvedSetupDecision,
      selectedRepo,
      settings?.agentCmdOverrides,
      settings?.terminalWindowsShell,
      settings?.rightSidebarOpenByDefault,
      setRightSidebarOpen,
      setRightSidebarTab,
      setSidebarOpen,
      setupDecision,
      sparseEnabled,
      sparseError,
      effectivePresetId,
      telemetrySource,
      shouldWaitForSetupCheck
    ]
  )

  const createDisabled =
    !repoId ||
    !workspaceSeedName ||
    creating ||
    shouldWaitForSetupCheck ||
    shouldWaitForIssueAutomationCheck ||
    (requiresExplicitSetupChoice && !setupDecision) ||
    sparseError !== null

  const cardProps: ComposerCardProps = {
    eligibleRepos,
    repoId,
    onRepoChange: handleRepoChange,
    name,
    onNameValueChange: handleNameValueChange,
    onSmartGitHubItemSelect: handleSmartGitHubItemSelect,
    onSmartBranchSelect: handleSmartBranchSelect,
    onSmartLinearIssueSelect: handleSmartLinearIssueSelect,
    smartNameSelection,
    onClearSmartNameSelection: handleClearSmartNameSelection,
    agentPrompt,
    onAgentPromptChange: setAgentPrompt,
    onPromptKeyDown: handlePromptKeyDown,
    linkedOnlyTemplatePreview: shouldApplyLinkedOnlyTemplate ? linkedOnlyTemplatePrompt : null,
    attachmentPaths,
    getAttachmentLabel,
    onAddAttachment: () => void handleAddAttachment(),
    onRemoveAttachment: (pathValue) =>
      setAttachmentPaths((current) => current.filter((currentPath) => currentPath !== pathValue)),
    addAttachmentShortcut: ADD_ATTACHMENT_SHORTCUT,
    linkedWorkItem,
    onRemoveLinkedWorkItem: handleRemoveLinkedWorkItem,
    linkPopoverOpen,
    onLinkPopoverOpenChange: handleLinkPopoverChange,
    linkQuery,
    onLinkQueryChange: setLinkQuery,
    filteredLinkItems,
    linkItemsLoading,
    linkDirectLoading,
    normalizedLinkQuery,
    onSelectLinkedItem: handleSelectLinkedItem,
    tuiAgent,
    onTuiAgentChange: setTuiAgent,
    detectedAgentIds,
    onOpenAgentSettings: handleOpenAgentSettings,
    advancedOpen,
    onToggleAdvanced: () => setAdvancedOpen((current) => !current),
    createDisabled,
    creating,
    onCreate: () => void submit(),
    baseBranch,
    onBaseBranchChange: handleBaseBranchChange,
    onBaseBranchPrSelect: handleBaseBranchPrSelect,
    baseBranchLinkedPrNumber:
      linkedWorkItem?.type === 'pr' && baseBranch ? linkedWorkItem.number : null,
    selectedRepoPath: selectedRepo?.path ?? null,
    selectedRepoIsRemote: Boolean(selectedRepo?.connectionId),
    startFromResetHint,
    note,
    onNoteChange: setNote,
    setupConfig,
    requiresExplicitSetupChoice,
    setupDecision,
    onSetupDecisionChange: setSetupDecision,
    shouldWaitForSetupCheck,
    resolvedSetupDecision,
    createError,
    canUseSparseCheckout: !selectedRepo?.connectionId,
    sparsePresets,
    sparseSelectedPresetId,
    onSparseSelectPreset: handleSparseSelectPreset
  }

  return {
    cardProps,
    composerRef,
    promptTextareaRef,
    nameInputRef,
    submit,
    submitQuick,
    createDisabled
  }
}
