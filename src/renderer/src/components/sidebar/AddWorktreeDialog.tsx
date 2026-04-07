/* eslint-disable max-lines */

import React, { useState, useCallback, useMemo, useRef } from 'react'
import { toast } from 'sonner'
import { ChevronRight } from 'lucide-react'
import { useAppStore } from '@/store'
import type { OrcaHooks, SetupDecision, SetupRunPolicy } from '../../../../shared/types'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem
} from '@/components/ui/select'
import RepoDotLabel from '@/components/repo/RepoDotLabel'
import { parseGitHubIssueOrPRNumber } from '@/lib/github-links'
import { SPACE_NAMES } from '@/constants/space-names'
import { ensureWorktreeHasInitialTerminal } from '@/lib/worktree-activation'
import { isGitRepoKind } from '../../../../shared/repo-kind'

const DIALOG_CLOSE_RESET_DELAY_MS = 200

const AddWorktreeDialog = React.memo(function AddWorktreeDialog() {
  const activeModal = useAppStore((s) => s.activeModal)
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const repos = useAppStore((s) => s.repos)
  const createWorktree = useAppStore((s) => s.createWorktree)
  const updateWorktreeMeta = useAppStore((s) => s.updateWorktreeMeta)
  const activeRepoId = useAppStore((s) => s.activeRepoId)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const setActiveRepo = useAppStore((s) => s.setActiveRepo)
  const setActiveWorktree = useAppStore((s) => s.setActiveWorktree)
  const setActiveView = useAppStore((s) => s.setActiveView)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const setSidebarOpen = useAppStore((s) => s.setSidebarOpen)
  const searchQuery = useAppStore((s) => s.searchQuery)
  const setSearchQuery = useAppStore((s) => s.setSearchQuery)
  const filterRepoIds = useAppStore((s) => s.filterRepoIds)
  const setFilterRepoIds = useAppStore((s) => s.setFilterRepoIds)
  const revealWorktreeInSidebar = useAppStore((s) => s.revealWorktreeInSidebar)
  const setRightSidebarOpen = useAppStore((s) => s.setRightSidebarOpen)
  const setRightSidebarTab = useAppStore((s) => s.setRightSidebarTab)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const settings = useAppStore((s) => s.settings)
  const eligibleRepos = useMemo(() => repos.filter((repo) => isGitRepoKind(repo)), [repos])

  const [repoId, setRepoId] = useState<string>('')
  const [name, setName] = useState('')
  const [linkedIssue, setLinkedIssue] = useState('')
  const [comment, setComment] = useState('')
  const [yamlHooks, setYamlHooks] = useState<OrcaHooks | null>(null)
  const [checkedHooksRepoId, setCheckedHooksRepoId] = useState<string | null>(null)
  const [setupDecision, setSetupDecision] = useState<'run' | 'skip' | null>(null)
  const [createError, setCreateError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const nameInputRef = useRef<HTMLInputElement>(null)
  const lastSuggestedNameRef = useRef('')
  const resetTimeoutRef = useRef<number | null>(null)
  const prevIsOpenRef = useRef(false)
  const prevSuggestedNameRef = useRef('')

  const isOpen = activeModal === 'create-worktree'
  const preselectedRepoId =
    typeof modalData.preselectedRepoId === 'string' ? modalData.preselectedRepoId : ''
  const activeWorktreeRepoId = useMemo(
    () => findRepoIdForWorktree(activeWorktreeId, worktreesByRepo),
    [activeWorktreeId, worktreesByRepo]
  )
  const selectedRepo = eligibleRepos.find((r) => r.id === repoId)
  const setupConfig = useMemo(
    () => getSetupConfig(selectedRepo, yamlHooks),
    [selectedRepo, yamlHooks]
  )
  const setupPolicy: SetupRunPolicy = selectedRepo?.hookSettings?.setupRunPolicy ?? 'run-by-default'
  const requiresExplicitSetupChoice = Boolean(setupConfig) && setupPolicy === 'ask'
  const resolvedSetupDecision =
    setupDecision ??
    (!setupConfig || setupPolicy === 'ask'
      ? null
      : setupPolicy === 'run-by-default'
        ? 'run'
        : 'skip')
  const suggestedName = useMemo(
    () => getSuggestedSpaceName(repoId, worktreesByRepo, settings?.nestWorkspaces ?? false),
    [repoId, worktreesByRepo, settings?.nestWorkspaces]
  )
  // Why: setup visibility is part of the create decision no matter which default
  // policy the repo uses. If we let create proceed before the async hook lookup
  // finishes, a repo with `orca.yaml` setup can silently launch setup (or hide a
  // skip/default choice) before the dialog ever surfaces that configuration.
  // Track which repo has completed a lookup so the first render after opening or
  // switching repos still counts as "checking".
  const isSetupCheckPending = Boolean(repoId) && checkedHooksRepoId !== repoId
  const shouldWaitForSetupCheck = Boolean(selectedRepo) && isSetupCheckPending

  // Auto-select repo when dialog opens (adjusting state during render)
  if (isOpen && !prevIsOpenRef.current && eligibleRepos.length > 0) {
    if (preselectedRepoId && eligibleRepos.some((repo) => repo.id === preselectedRepoId)) {
      setRepoId(preselectedRepoId)
    } else if (
      activeWorktreeRepoId &&
      eligibleRepos.some((repo) => repo.id === activeWorktreeRepoId)
    ) {
      setRepoId(activeWorktreeRepoId)
    } else if (activeRepoId && eligibleRepos.some((repo) => repo.id === activeRepoId)) {
      setRepoId(activeRepoId)
    } else {
      setRepoId(eligibleRepos[0].id)
    }
  }
  prevIsOpenRef.current = isOpen

  // Auto-fill name from suggestion (adjusting state during render)
  if (isOpen && repoId && suggestedName && suggestedName !== prevSuggestedNameRef.current) {
    const shouldApplySuggestion = !name.trim() || name === lastSuggestedNameRef.current
    prevSuggestedNameRef.current = suggestedName
    if (shouldApplySuggestion) {
      setName(suggestedName)
      lastSuggestedNameRef.current = suggestedName
    }
  }
  if (!isOpen) {
    prevSuggestedNameRef.current = ''
  }

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        closeModal()
      }
    },
    [closeModal]
  )

  const handleCreate = useCallback(async () => {
    if (!repoId || !name.trim() || shouldWaitForSetupCheck || !selectedRepo) {
      return
    }
    setCreateError(null)
    setCreating(true)
    try {
      const result = await createWorktree(
        repoId,
        name.trim(),
        undefined,
        setupConfig ? ((resolvedSetupDecision ?? 'inherit') as SetupDecision) : 'inherit'
      )
      const wt = result.worktree
      // Meta update is best-effort — the worktree already exists, so don't
      // block the success path if only the metadata write fails.
      try {
        const metaUpdates: Record<string, unknown> = {}
        if (linkedIssue.trim()) {
          const linkedIssueNumber = parseGitHubIssueOrPRNumber(linkedIssue)
          if (linkedIssueNumber !== null) {
            ;(metaUpdates as { linkedIssue: number }).linkedIssue = linkedIssueNumber
          }
        }
        if (comment.trim()) {
          ;(metaUpdates as { comment: string }).comment = comment.trim()
        }
        if (Object.keys(metaUpdates).length > 0) {
          await updateWorktreeMeta(wt.id, metaUpdates as { linkedIssue?: number; comment?: string })
        }
      } catch {
        console.error('Failed to update worktree meta after creation')
      }

      setActiveRepo(repoId)
      setActiveView('terminal')
      setSidebarOpen(true)
      if (searchQuery) {
        setSearchQuery('')
      }
      if (filterRepoIds.length > 0 && !filterRepoIds.includes(repoId)) {
        setFilterRepoIds([])
      }
      setActiveWorktree(wt.id)
      ensureWorktreeHasInitialTerminal(useAppStore.getState(), wt.id, result.setup)
      revealWorktreeInSidebar(wt.id)
      if (settings?.rightSidebarOpenByDefault) {
        setRightSidebarTab('explorer')
        setRightSidebarOpen(true)
      }
      handleOpenChange(false)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create worktree.'
      setCreateError(message)
      toast.error(message)
    } finally {
      setCreating(false)
    }
  }, [
    repoId,
    name,
    linkedIssue,
    comment,
    createWorktree,
    updateWorktreeMeta,
    setActiveRepo,
    setActiveView,
    setSidebarOpen,
    searchQuery,
    setSearchQuery,
    filterRepoIds,
    setFilterRepoIds,
    setActiveWorktree,
    revealWorktreeInSidebar,
    setRightSidebarOpen,
    setRightSidebarTab,
    settings?.rightSidebarOpenByDefault,
    handleOpenChange,
    resolvedSetupDecision,
    selectedRepo,
    setupConfig,
    shouldWaitForSetupCheck
  ])

  const handleNameChange = useCallback(
    (value: string) => {
      setName(value)
      if (createError) {
        setCreateError(null)
      }
    },
    [createError]
  )

  const handleRepoChange = useCallback(
    (value: string) => {
      setRepoId(value)
      setYamlHooks(null)
      setCheckedHooksRepoId(null)
      setSetupDecision(null)
      if (createError) {
        setCreateError(null)
      }
    },
    [createError]
  )

  const handleOpenSetupSettings = useCallback(() => {
    if (!selectedRepo) {
      return
    }

    // Why: the create dialog intentionally keeps setup details collapsed so the
    // branch-creation flow stays lightweight; clicking setup is the escape hatch
    // into the full repository hook editor.
    openSettingsTarget({ pane: 'repo', repoId: selectedRepo.id })
    handleOpenChange(false)
    setActiveView('settings')
  }, [handleOpenChange, openSettingsTarget, selectedRepo, setActiveView])

  // Auto-select repo when opening.
  React.useEffect(() => {
    if (resetTimeoutRef.current !== null) {
      window.clearTimeout(resetTimeoutRef.current)
      resetTimeoutRef.current = null
    }

    if (isOpen) {
      return
    }

    resetTimeoutRef.current = window.setTimeout(() => {
      setRepoId('')
      setName('')
      setLinkedIssue('')
      setComment('')
      setYamlHooks(null)
      setCheckedHooksRepoId(null)
      setSetupDecision(null)
      setCreateError(null)
      lastSuggestedNameRef.current = ''
      resetTimeoutRef.current = null
    }, DIALOG_CLOSE_RESET_DELAY_MS)

    return () => {
      if (resetTimeoutRef.current !== null) {
        window.clearTimeout(resetTimeoutRef.current)
        resetTimeoutRef.current = null
      }
    }
  }, [isOpen])

  // Focus and select name input when suggestion is applied
  React.useEffect(() => {
    if (!isOpen || !repoId || !suggestedName) {
      return
    }
    requestAnimationFrame(() => {
      const input = nameInputRef.current
      if (!input) {
        return
      }
      input.focus()
      input.select()
    })
  }, [isOpen, repoId, suggestedName])

  // Safety guard: creating a worktree requires at least one repo.
  React.useEffect(() => {
    if (isOpen && repos.length === 0) {
      handleOpenChange(false)
    }
  }, [eligibleRepos.length, handleOpenChange, isOpen, repos.length])

  React.useEffect(() => {
    if (!isOpen || !repoId) {
      return
    }

    let cancelled = false

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

    return () => {
      cancelled = true
    }
  }, [isOpen, repoId])

  React.useEffect(() => {
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

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey && repoId && name.trim() && !creating) {
        if (shouldWaitForSetupCheck || (requiresExplicitSetupChoice && !setupDecision)) {
          return
        }
        e.preventDefault()
        handleCreate()
      }
    },
    [
      repoId,
      name,
      creating,
      handleCreate,
      requiresExplicitSetupChoice,
      setupDecision,
      shouldWaitForSetupCheck
    ]
  )

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md" onKeyDown={handleKeyDown}>
        <DialogHeader>
          <DialogTitle className="text-sm">New Worktree</DialogTitle>
          <DialogDescription className="text-xs">
            Create a new git worktree on a fresh branch cut from the selected base ref.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {/* Repo selector */}
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-muted-foreground">Repository</label>
            <Select value={repoId} onValueChange={handleRepoChange}>
              <SelectTrigger className="h-8 text-xs w-full">
                <SelectValue placeholder="Select repo...">
                  {selectedRepo ? (
                    <RepoDotLabel
                      name={selectedRepo.displayName}
                      color={selectedRepo.badgeColor}
                      dotClassName="size-1.5"
                    />
                  ) : null}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {eligibleRepos.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    <RepoDotLabel name={r.displayName} color={r.badgeColor} />
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Name */}
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-muted-foreground">Name</label>
            <Input
              ref={nameInputRef}
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder="feature/my-feature"
              className="h-8 text-xs"
              autoFocus
            />
            {createError && <p className="text-[10px] text-destructive">{createError}</p>}
            {shouldWaitForSetupCheck ? (
              <p className="text-[10px] text-muted-foreground">Checking setup configuration...</p>
            ) : null}
          </div>

          {setupConfig ? (
            <div className="space-y-2 rounded-xl border border-border/60 bg-muted/20 p-3">
              <div className="flex items-start justify-between gap-2">
                <button
                  type="button"
                  onClick={setupConfig.source === 'yaml' ? undefined : handleOpenSetupSettings}
                  className="group min-w-0 flex-1 rounded-md text-left outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <div className="flex items-center gap-1 text-[11px] font-medium text-foreground">
                    <span>Setup</span>
                    {setupConfig.source !== 'yaml' && (
                      <ChevronRight className="size-3 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                    )}
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    {setupConfig.source === 'yaml' ? (
                      <>
                        This repository uses{' '}
                        <code className="rounded bg-muted px-1 py-0.5">orca.yaml</code> to define
                        its setup command.
                      </>
                    ) : (
                      'Review setup status here and migrate this legacy command in repository settings.'
                    )}
                  </p>
                </button>
                <span className="rounded-full border border-border/60 px-2 py-0.5 text-[10px] text-muted-foreground">
                  {setupPolicy === 'ask'
                    ? 'Ask every time'
                    : setupPolicy === 'run-by-default'
                      ? 'Run by default'
                      : 'Skip by default'}
                </span>
              </div>

              <div className="space-y-1 rounded-lg border border-border/50 bg-background/60 p-2">
                <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                  {setupConfig.source === 'yaml' ? 'orca.yaml' : 'Command Preview'}
                </p>
                <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-muted-foreground">
                  {summarizeSetupCommand(setupConfig.command)}
                </pre>
              </div>

              {requiresExplicitSetupChoice ? (
                <div className="space-y-2">
                  <label className="text-[11px] font-medium text-muted-foreground">
                    Run setup now?
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    {(
                      [
                        ['run', 'Run setup now'],
                        ['skip', 'Skip for now']
                      ] as const
                    ).map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => setSetupDecision(value)}
                        className={`rounded-md border px-3 py-2 text-left text-xs transition-colors ${
                          setupDecision === value
                            ? 'border-foreground bg-accent text-accent-foreground'
                            : 'border-border/60 text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  {!setupDecision ? (
                    <p className="text-[10px] text-muted-foreground">
                      {shouldWaitForSetupCheck
                        ? 'Checking setup configuration...'
                        : 'Choose whether to run setup before creating this worktree.'}
                    </p>
                  ) : null}
                </div>
              ) : (
                <label className="flex items-center gap-2 text-[11px] text-foreground">
                  <input
                    type="checkbox"
                    checked={resolvedSetupDecision === 'run'}
                    onChange={(e) => setSetupDecision(e.target.checked ? 'run' : 'skip')}
                  />
                  Run setup command after creation
                </label>
              )}
            </div>
          ) : null}

          {/* Link GH Issue */}
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-muted-foreground">
              Link GH Issue <span className="text-muted-foreground/50">(optional)</span>
            </label>
            <Input
              value={linkedIssue}
              onChange={(e) => setLinkedIssue(e.target.value)}
              placeholder="Issue # or GitHub URL"
              className="h-8 text-xs"
            />
            <p className="text-[10px] text-muted-foreground">
              Paste an issue URL, or enter a number.
            </p>
          </div>

          {/* Comment */}
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-muted-foreground">
              Comment <span className="text-muted-foreground/50">(optional)</span>
            </label>
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Notes about this worktree..."
              rows={2}
              className="w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-2 text-xs shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 resize-none"
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleOpenChange(false)}
            className="text-xs"
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleCreate}
            disabled={
              !repoId ||
              !name.trim() ||
              creating ||
              shouldWaitForSetupCheck ||
              !selectedRepo ||
              (requiresExplicitSetupChoice && !setupDecision)
            }
            className="text-xs"
          >
            {creating ? 'Creating...' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})

export default AddWorktreeDialog

function getSuggestedSpaceName(
  repoId: string,
  worktreesByRepo: Record<string, { path: string }[]>,
  nestWorkspaces: boolean
): string {
  if (!repoId) {
    return SPACE_NAMES[0]
  }

  const usedNames = new Set<string>()
  const repoWorktrees = worktreesByRepo[repoId] ?? []

  for (const worktree of repoWorktrees) {
    usedNames.add(normalizeSpaceName(lastPathSegment(worktree.path)))
  }

  if (!nestWorkspaces) {
    for (const worktrees of Object.values(worktreesByRepo)) {
      for (const worktree of worktrees) {
        usedNames.add(normalizeSpaceName(lastPathSegment(worktree.path)))
      }
    }
  }

  for (const candidate of SPACE_NAMES) {
    if (!usedNames.has(normalizeSpaceName(candidate))) {
      return candidate
    }
  }

  let suffix = 2
  while (true) {
    for (const candidate of SPACE_NAMES) {
      const numberedCandidate = `${candidate}-${suffix}`
      if (!usedNames.has(normalizeSpaceName(numberedCandidate))) {
        return numberedCandidate
      }
    }
    suffix += 1
  }
}

function lastPathSegment(path: string): string {
  // Why: worktree paths come from the OS, so Windows worktrees use backslashes.
  // Split on both separators or the suggestion logic treats the whole absolute
  // path as the "name" and starts re-suggesting already-used worktree names.
  return (
    path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ?? path
  )
}

function normalizeSpaceName(name: string): string {
  return name.trim().toLowerCase()
}

function findRepoIdForWorktree(
  worktreeId: string | null,
  worktreesByRepo: Record<string, { id: string }[]>
): string | null {
  if (!worktreeId) {
    return null
  }

  for (const [repoId, worktrees] of Object.entries(worktreesByRepo)) {
    if (worktrees.some((worktree) => worktree.id === worktreeId)) {
      return repoId
    }
  }

  return null
}

function getSetupConfig(
  repo:
    | {
        hookSettings?: {
          setupRunPolicy?: SetupRunPolicy
          scripts?: { setup?: string }
        }
      }
    | undefined,
  yamlHooks: OrcaHooks | null
): { source: 'yaml' | 'legacy-ui'; command: string } | null {
  if (!repo) {
    return null
  }

  const yamlSetup = yamlHooks?.scripts.setup?.trim()

  if (yamlSetup) {
    return { source: 'yaml', command: yamlSetup }
  }

  const legacySetup = repo.hookSettings?.scripts?.setup?.trim()
  if (legacySetup) {
    // Why: the backend still honors persisted pre-yaml hook commands for backwards
    // compatibility, so the create dialog must surface the same effective setup
    // command instead of pretending the repo has no setup configured.
    return { source: 'legacy-ui', command: legacySetup }
  }

  return null
}

function summarizeSetupCommand(command: string): string {
  const trimmed = command.trim()
  if (!trimmed) {
    return '(empty setup command)'
  }

  const lines = trimmed.split(/\r?\n/)
  if (lines.length <= 4) {
    return trimmed
  }

  return `${lines.slice(0, 4).join('\n')}\n...`
}
