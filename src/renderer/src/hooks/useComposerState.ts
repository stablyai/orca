/* eslint-disable max-lines -- Why: this hook co-locates every piece of state
the NewWorkspaceComposerCard reads or mutates, so both the full-page composer
and the global quick-composer modal can consume a single unified source of
truth without duplicating effects, derivation, or the create side-effect. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { AGENT_CATALOG } from '@/lib/agent-catalog'
import { parseGitHubIssueOrPRNumber, normalizeGitHubLinkQuery } from '@/lib/github-links'
import type { RepoSlug } from '@/lib/github-links'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { buildAgentStartupPlan } from '@/lib/tui-agent-startup'
import { isGitRepoKind } from '../../../shared/repo-kind'
import type {
  GitHubWorkItem,
  OrcaHooks,
  SetupDecision,
  SetupRunPolicy,
  TuiAgent
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
  renderIssueCommandTemplate,
  type LinkedWorkItemSummary
} from '@/lib/new-workspace'

export type UseComposerStateOptions = {
  initialRepoId?: string
  initialName?: string
  initialPrompt?: string
  initialLinkedWorkItem?: LinkedWorkItemSummary | null
  /** Why: the full-page composer persists drafts so users can navigate away
   *  without losing work; the quick-composer modal is transient and must not
   *  clobber or leak that long-running draft. */
  persistDraft: boolean
  /** Invoked after a successful createWorktree. The caller usually closes its
   *  surface here (palette modal, full page, etc.). */
  onCreated?: () => void
  /** Optional external repoId override — used by NewWorkspacePage's task list
   *  which wants to drive repo selection from the page header, not the card. */
  repoIdOverride?: string
  onRepoIdOverrideChange?: (value: string) => void
}

export type ComposerCardProps = {
  eligibleRepos: ReturnType<typeof useAppStore.getState>['repos']
  repoId: string
  onRepoChange: (value: string) => void
  name: string
  onNameChange: (event: React.ChangeEvent<HTMLInputElement>) => void
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
  normalizedLinkQuery: { query: string; repoMismatch: string | null }
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
  setupConfig: { source: 'yaml' | 'legacy'; command: string } | null
  requiresExplicitSetupChoice: boolean
  setupDecision: 'run' | 'skip' | null
  onSetupDecisionChange: (value: 'run' | 'skip') => void
  shouldWaitForSetupCheck: boolean
  resolvedSetupDecision: 'run' | 'skip' | null
  createError: string | null
}

export type UseComposerStateResult = {
  cardProps: ComposerCardProps
  /** Ref the consumer should attach to the composer wrapper so the global
   *  Enter-to-submit handler can scope its behavior to the visible composer. */
  composerRef: React.RefObject<HTMLDivElement | null>
  promptTextareaRef: React.RefObject<HTMLTextAreaElement | null>
  nameInputRef: React.RefObject<HTMLInputElement | null>
  submit: () => Promise<void>
  /** Invoked by the Enter handler to re-check whether submission should fire. */
  createDisabled: boolean
}

// Why: both the full-page NewWorkspacePage composer and the Cmd+J modal can
// be mounted simultaneously. Without instance scoping, a single native file
// drop fires every subscriber and duplicates attachments/prompt edits across
// the background draft and the visible modal. Route drops to the
// most-recently-mounted composer only — the modal stacks on top, so the
// modal wins when both are present, and the page takes over once the modal
// closes.
const composerDropStack: symbol[] = []

// Why: agent detection runs `which` for every agent binary on PATH — an IPC
// round-trip that takes 50–200ms. The set of installed agents doesn't change
// within a session, so cache the promise at module scope to collapse all
// mounts (page + modal, reopen, etc.) onto a single resolve.
let detectAgentsPromise: Promise<TuiAgent[]> | null = null
function detectAgentsCached(): Promise<TuiAgent[]> {
  if (detectAgentsPromise) {
    return detectAgentsPromise
  }
  const pending = window.api.preflight
    .detectAgents()
    .then((ids) => ids as TuiAgent[])
    .catch(() => {
      // Allow a retry on the next mount if detection blew up (e.g. IPC
      // timeout during cold start).
      detectAgentsPromise = null
      return [] as TuiAgent[]
    })
  detectAgentsPromise = pending
  return pending
}

export function useComposerState(options: UseComposerStateOptions): UseComposerStateResult {
  const {
    initialRepoId,
    initialName = '',
    initialPrompt = '',
    initialLinkedWorkItem = null,
    persistDraft,
    onCreated,
    repoIdOverride,
    onRepoIdOverrideChange
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
      openSettingsPage: s.openSettingsPage,
      openSettingsTarget: s.openSettingsTarget
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
    openSettingsPage,
    openSettingsTarget
  } = actions

  const repos = useAppStore((s) => s.repos)
  const activeRepoId = useAppStore((s) => s.activeRepoId)
  const settings = useAppStore((s) => s.settings)
  const newWorkspaceDraft = useAppStore((s) => s.newWorkspaceDraft)

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
  const [tuiAgent, setTuiAgent] = useState<TuiAgent>(
    persistDraft
      ? (newWorkspaceDraft?.agent ?? settings?.defaultTuiAgent ?? 'claude')
      : (settings?.defaultTuiAgent ?? 'claude')
  )
  const [detectedAgentIds, setDetectedAgentIds] = useState<Set<TuiAgent> | null>(null)

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

  const [linkPopoverOpen, setLinkPopoverOpen] = useState(false)
  const [linkQuery, setLinkQuery] = useState('')
  const [linkDebouncedQuery, setLinkDebouncedQuery] = useState('')
  const [linkItems, setLinkItems] = useState<GitHubWorkItem[]>([])
  const [linkItemsLoading, setLinkItemsLoading] = useState(false)
  const [linkDirectItem, setLinkDirectItem] = useState<GitHubWorkItem | null>(null)
  const [linkDirectLoading, setLinkDirectLoading] = useState(false)
  const [linkRepoSlug, setLinkRepoSlug] = useState<RepoSlug | null>(null)

  const lastAutoNameRef = useRef<string>(
    persistDraft ? (newWorkspaceDraft?.name ?? initialName) : initialName
  )
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
  const parsedLinkedIssueNumber = useMemo(
    () => (linkedIssue.trim() ? parseGitHubIssueOrPRNumber(linkedIssue) : null),
    [linkedIssue]
  )
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

  const workspaceSeedName = useMemo(
    () =>
      getWorkspaceSeedName({
        explicitName: name,
        prompt: agentPrompt,
        linkedIssueNumber: parsedLinkedIssueNumber,
        linkedPR
      }),
    [agentPrompt, linkedPR, name, parsedLinkedIssueNumber]
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
    () => normalizeGitHubLinkQuery(linkDebouncedQuery, linkRepoSlug),
    [linkDebouncedQuery, linkRepoSlug]
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
      linkedPR
    })
  }, [
    persistDraft,
    agentPrompt,
    attachmentPaths,
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

  // Detect installed agents once on mount (cached at module scope so the
  // page composer and quick-composer modal share a single IPC round-trip).
  useEffect(() => {
    let cancelled = false
    void detectAgentsCached().then((ids) => {
      if (cancelled) {
        return
      }
      setDetectedAgentIds(new Set(ids))
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
    // Why: intentionally run only once on mount — detection is a best-effort
    // PATH snapshot and does not need to re-run when the draft or settings change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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

  // Per-repo: resolve repo slug for GH URL mismatch detection.
  useEffect(() => {
    if (!selectedRepo) {
      setLinkRepoSlug(null)
      return
    }

    let cancelled = false
    void window.api.gh
      .repoSlug({ repoPath: selectedRepo.path })
      .then((slug) => {
        if (!cancelled) {
          setLinkRepoSlug(slug)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLinkRepoSlug(null)
        }
      })

    return () => {
      cancelled = true
    }
  }, [selectedRepo])

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

    void window.api.gh
      .listWorkItems({ repoPath: selectedRepo.path, limit: 100 })
      .then((items) => {
        if (!cancelled) {
          setLinkItems(items)
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
    void window.api.gh
      .workItem({ repoPath: selectedRepo.path, number: normalizedLinkQuery.directNumber })
      .then((item) => {
        if (!cancelled) {
          setLinkDirectItem(item)
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

  const handleNameChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>): void => {
      const nextName = event.target.value
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
      setRepoId(value)
      setLinkedIssue('')
      setLinkedPR(null)
      setLinkedWorkItem(null)
    },
    [setRepoId]
  )

  const handleOpenAgentSettings = useCallback((): void => {
    openSettingsTarget({ pane: 'agents', repoId: null })
    openSettingsPage()
  }, [openSettingsPage, openSettingsTarget])

  const submit = useCallback(async (): Promise<void> => {
    const workspaceName = workspaceSeedName
    if (
      !repoId ||
      !workspaceName ||
      !selectedRepo ||
      shouldWaitForSetupCheck ||
      shouldWaitForIssueAutomationCheck ||
      (requiresExplicitSetupChoice && !setupDecision)
    ) {
      return
    }

    setCreateError(null)
    setCreating(true)
    try {
      const result = await createWorktree(
        repoId,
        workspaceName,
        undefined,
        (resolvedSetupDecision ?? 'inherit') as SetupDecision
      )
      const worktree = result.worktree

      try {
        const metaUpdates: {
          linkedIssue?: number
          linkedPR?: number
          comment?: string
        } = {}
        if (parsedLinkedIssueNumber !== null) {
          metaUpdates.linkedIssue = parsedLinkedIssueNumber
        }
        if (linkedPR !== null) {
          metaUpdates.linkedPR = linkedPR
        }
        if (note.trim()) {
          metaUpdates.comment = note.trim()
        }
        if (Object.keys(metaUpdates).length > 0) {
          await updateWorktreeMeta(worktree.id, metaUpdates)
        }
      } catch {
        console.error('Failed to update worktree meta after creation')
      }

      const issueCommand = shouldRunIssueAutomation
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

      activateAndRevealWorktree(worktree.id, {
        setup: result.setup,
        issueCommand,
        ...(startupPlan ? { startup: { command: startupPlan.launchCommand } } : {})
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
    clearNewWorkspaceDraft,
    createWorktree,
    issueCommandTemplate,
    linkedPR,
    linkedWorkItem?.url,
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
    tuiAgent,
    shouldRunIssueAutomation,
    shouldWaitForIssueAutomationCheck,
    shouldWaitForSetupCheck,
    startupPrompt,
    updateWorktreeMeta,
    workspaceSeedName
  ])

  const createDisabled =
    !repoId ||
    !workspaceSeedName ||
    creating ||
    shouldWaitForSetupCheck ||
    shouldWaitForIssueAutomationCheck ||
    (requiresExplicitSetupChoice && !setupDecision)

  const cardProps: ComposerCardProps = {
    eligibleRepos,
    repoId,
    onRepoChange: handleRepoChange,
    name,
    onNameChange: handleNameChange,
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
    note,
    onNoteChange: setNote,
    setupConfig,
    requiresExplicitSetupChoice,
    setupDecision,
    onSetupDecisionChange: setSetupDecision,
    shouldWaitForSetupCheck,
    resolvedSetupDecision,
    createError
  }

  return {
    cardProps,
    composerRef,
    promptTextareaRef,
    nameInputRef,
    submit,
    createDisabled
  }
}
