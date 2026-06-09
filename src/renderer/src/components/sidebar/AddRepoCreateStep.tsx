// Step for AddRepoDialog (orca#763), split out so create-project state stays scoped.
import React, { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Folder, GitBranch } from 'lucide-react'
import { useAppStore } from '@/store'
import { useMountedRef } from '@/hooks/useMountedRef'
import { DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { markOnboardingProjectAdded } from '@/lib/onboarding-project-checklist'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import type { Repo } from '../../../../shared/types'
import {
  CreateProjectLocationField,
  CreateProjectParentBrowser
} from './CreateProjectLocationField'
import { translate } from '@/i18n/i18n'

type RepoKind = 'git' | 'folder'

export function useCreateRepo(
  fetchWorktrees: (
    repoId: string,
    options?: { requireAuthoritative?: boolean }
  ) => Promise<boolean>,
  closeModal: () => void,
  onGitRepoReady?: (repoId: string) => void | Promise<void>
) {
  const [createName, setCreateName] = useState('')
  const [createParent, setCreateParent] = useState('')
  const [createKind, setCreateKind] = useState<RepoKind>('git')
  const [createError, setCreateError] = useState<string | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const mountedRef = useMountedRef()

  // Why: monotonic ID so stale create callbacks can detect they were superseded
  // when the user clicks Back or closes the dialog mid-create. Mirrors the
  // cloneGenRef pattern in AddRepoDialog.
  const createGenRef = useRef(0)

  const resetCreateState = useCallback(() => {
    createGenRef.current++
    setCreateName('')
    setCreateParent('')
    setCreateKind('git')
    setCreateError(null)
    setIsCreating(false)
  }, [])

  const handlePickParent = useCallback(async () => {
    if (useAppStore.getState().settings?.activeRuntimeEnvironmentId?.trim()) {
      // Why: the native folder picker returns a client-local path. Runtime
      // project creation needs an explicit server parent path.
      toast.error(translate("auto.components.sidebar.AddRepoCreateStep.875dda0995", "Enter a server parent path."))
      return
    }
    const gen = createGenRef.current
    const dir = await window.api.repos.pickDirectory()
    if (dir && gen === createGenRef.current && mountedRef.current) {
      setCreateParent(dir)
      setCreateError(null)
    }
  }, [mountedRef])

  const handleCreate = useCallback(async () => {
    const name = createName.trim()
    const parentPath = createParent.trim()
    if (!name || !parentPath) {
      return
    }
    const gen = ++createGenRef.current
    setIsCreating(true)
    setCreateError(null)
    try {
      const target = getActiveRuntimeTarget(useAppStore.getState().settings)
      const result =
        target.kind === 'environment'
          ? await callRuntimeRpc<{ repo: Repo } | { error: string }>(
              target,
              'repo.create',
              {
                parentPath,
                name,
                kind: createKind
              },
              { timeoutMs: 60_000 }
            )
          : await window.api.repos.create({
              parentPath,
              name,
              kind: createKind
            })
      // Why: if the user closed the dialog or clicked Back mid-create,
      // createGenRef was bumped by resetCreateState. Ignore stale results.
      if (gen !== createGenRef.current || !mountedRef.current) {
        return
      }
      if ('error' in result) {
        setCreateError(result.error)
        return
      }
      const repo = result.repo
      // Upsert into the store before the repos:changed event round-trips,
      // so the next step can find the repo immediately.
      const state = useAppStore.getState()
      const existingIdx = state.repos.findIndex((r) => r.id === repo.id)
      // Why: the IPC handler dedupes by path (see repos:create) and returns
      // the existing repo unchanged. If its ID is already in our store, the
      // handler took the dedup path — no new project was created, so don't
      // claim one was.
      const wasDeduped = existingIdx !== -1
      if (existingIdx === -1) {
        useAppStore.setState({ repos: [...state.repos, repo] })
      } else {
        const updated = [...state.repos]
        updated[existingIdx] = repo
        useAppStore.setState({ repos: updated })
      }
      if (wasDeduped) {
        toast.info(translate("auto.components.sidebar.AddRepoCreateStep.2c12db1511", "Project already added"), {
          description: repo.displayName
        })
      } else {
        toast.success(translate("auto.components.sidebar.AddRepoCreateStep.5e97f0c4b9", "Project created"), {
          description: repo.displayName
        })
      }
      if (isGitRepoKind(repo)) {
        // Why: Git repos use the shared default-checkout completion path.
        // Why: if refresh is temporarily non-authoritative, the shared opener
        // still reveals the project so the user is not left in a completed add flow.
        await fetchWorktrees(repo.id, { requireAuthoritative: true })
        if (gen !== createGenRef.current || !mountedRef.current) {
          return
        }
        await onGitRepoReady?.(repo.id)
      } else {
        // Why: folder repos skip the Git default-checkout handoff, so activate the synthetic
        // root workspace before closing. Matches addNonGitFolder's behavior.
        await fetchWorktrees(repo.id)
        if (gen !== createGenRef.current || !mountedRef.current) {
          return
        }
        const folderWorktree = useAppStore.getState().worktreesByRepo[repo.id]?.[0]
        if (folderWorktree) {
          activateAndRevealWorktree(folderWorktree.id, { sidebarRevealBehavior: 'auto' })
        }
        await markOnboardingProjectAdded('addedFolder')
        closeModal()
      }
    } catch (err) {
      if (gen !== createGenRef.current || !mountedRef.current) {
        return
      }
      setCreateError(err instanceof Error ? err.message : String(err))
    } finally {
      // Why: only clear the loading state if this invocation is still current;
      // a superseded create must not flip the flag back off for a new flow.
      if (gen === createGenRef.current && mountedRef.current) {
        setIsCreating(false)
      }
    }
  }, [createName, createParent, createKind, fetchWorktrees, mountedRef, closeModal, onGitRepoReady])

  return {
    createName,
    createParent,
    createKind,
    createError,
    isCreating,
    setCreateName,
    setCreateParent,
    setCreateKind,
    setCreateError,
    resetCreateState,
    handlePickParent,
    handleCreate
  }
}

// ── UI helpers ───────────────────────────────────────────────────────

type KindCardProps = {
  kind: RepoKind
  selected: boolean
  disabled: boolean
  onSelect: () => void
  onArrowNav: () => void
  icon: React.ReactNode
  title: string
  caption: string
}

function KindCard({
  kind,
  selected,
  disabled,
  onSelect,
  onArrowNav,
  icon,
  title,
  caption
}: KindCardProps): React.JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      tabIndex={selected ? 0 : -1}
      onClick={onSelect}
      onKeyDown={(e) => {
        // Why: WAI-ARIA radiogroup spec expects all four arrow keys to move
        // selection. Left/Right handle the horizontal grid layout; Up/Down
        // are added so vertical nav (e.g. screen-reader users, future layout
        // changes) behaves the same.
        if (
          e.key === 'ArrowLeft' ||
          e.key === 'ArrowRight' ||
          e.key === 'ArrowUp' ||
          e.key === 'ArrowDown'
        ) {
          e.preventDefault()
          onArrowNav()
        } else if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault()
          onSelect()
        }
      }}
      disabled={disabled}
      data-kind={kind}
      className={`group relative flex items-center gap-3 rounded-md border px-3.5 py-3.5 text-left text-xs transition-colors cursor-pointer outline-none ${
        selected ? 'border-foreground/30 bg-accent' : 'border-border hover:bg-accent/50'
      } focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60`}
    >
      {/* Icon chip gives the glyph enough weight to sit balanced next to the title block. */}
      <span
        className={`shrink-0 inline-flex items-center justify-center size-8 rounded-md border transition-colors ${
          selected
            ? 'border-foreground/20 bg-background/60 text-foreground'
            : 'border-border/70 bg-background/30 text-muted-foreground group-hover:text-foreground'
        }`}
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] font-medium leading-tight">{title}</span>
        <span className="block text-[11px] text-muted-foreground leading-snug mt-0.5">
          {caption}
        </span>
      </span>
    </button>
  )
}

type CreateStepProps = {
  createName: string
  createParent: string
  createKind: RepoKind
  createError: string | null
  isCreating: boolean
  manualParentEntry?: boolean
  runtimeEnvironmentId?: string | null
  onNameChange: (value: string) => void
  onParentChange: (value: string) => void
  onKindChange: (kind: RepoKind) => void
  onPickParent: () => void
  onCreate: () => void
}

export function CreateStep({
  createName,
  createParent,
  createKind,
  createError,
  isCreating,
  manualParentEntry = false,
  runtimeEnvironmentId,
  onNameChange,
  onParentChange,
  onKindChange,
  onPickParent,
  onCreate
}: CreateStepProps): React.JSX.Element {
  const radioGroupRef = useRef<HTMLDivElement>(null)
  const radioFocusFrameRef = useRef<number | null>(null)
  const [browsingParent, setBrowsingParent] = useState(false)

  const cancelRadioFocusFrame = useCallback((): void => {
    if (radioFocusFrameRef.current === null) {
      return
    }
    cancelAnimationFrame(radioFocusFrameRef.current)
    radioFocusFrameRef.current = null
  }, [])

  const setRadioGroupNode = useCallback(
    (node: HTMLDivElement | null): void => {
      // Why: the queued arrow-key focus is only valid while this radiogroup is mounted.
      if (!node) {
        cancelRadioFocusFrame()
      }
      radioGroupRef.current = node
    },
    [cancelRadioFocusFrame]
  )

  // Arrow keys cycle selection within the radiogroup (WAI-ARIA radio pattern).
  const cycleKind = useCallback(() => {
    const next = createKind === 'git' ? 'folder' : 'git'
    onKindChange(next)
    cancelRadioFocusFrame()
    radioFocusFrameRef.current = requestAnimationFrame(() => {
      radioFocusFrameRef.current = null
      const nextEl = radioGroupRef.current?.querySelector<HTMLButtonElement>(
        `[data-kind="${next}"]`
      )
      nextEl?.focus()
    })
  }, [cancelRadioFocusFrame, createKind, onKindChange])

  const canSubmit = createName.trim().length > 0 && createParent.trim().length > 0 && !isCreating

  if (browsingParent && runtimeEnvironmentId) {
    return (
      <CreateProjectParentBrowser
        runtimeEnvironmentId={runtimeEnvironmentId}
        createParent={createParent}
        onParentChange={onParentChange}
        onClose={() => setBrowsingParent(false)}
      />
    )
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{translate("auto.components.sidebar.AddRepoCreateStep.db9be12229", "Start a new project")}</DialogTitle>
        <DialogDescription>
          {translate("auto.components.sidebar.AddRepoCreateStep.d877ece0d6", "Create a Git repository or a plain folder and open it in Orca.")}</DialogDescription>
      </DialogHeader>

      {/* Why: DialogContent is a CSS grid; grid items default to min-width:auto
        (= content size), so a long path inside the Location row would blow out
        the dialog width even with flex + truncate on the row itself. min-w-0
        here caps the grid track at the dialog's max-width. */}
      <div className="space-y-3.5 pt-1 min-w-0">
        {/* Kind toggle. Real radiogroup so screen readers announce it as a choice. */}
        <div
          ref={setRadioGroupNode}
          role="radiogroup"
          aria-label={translate("auto.components.sidebar.AddRepoCreateStep.180e9b5e48", "Project kind")}
          className="grid grid-cols-2 gap-2"
        >
          <KindCard
            kind="git"
            selected={createKind === 'git'}
            disabled={isCreating}
            onSelect={() => onKindChange('git')}
            onArrowNav={cycleKind}
            icon={<GitBranch className="size-4" />}
            title={translate("auto.components.sidebar.AddRepoCreateStep.11fd2a7db8", "Git repository")}
            caption="Initializes an empty Git repo"
          />
          <KindCard
            kind="folder"
            selected={createKind === 'folder'}
            disabled={isCreating}
            onSelect={() => onKindChange('folder')}
            onArrowNav={cycleKind}
            icon={<Folder className="size-4" />}
            title={translate("auto.components.sidebar.AddRepoCreateStep.038729c107", "Folder")}
            caption="Create a new folder"
          />
        </div>

        {/* Name. Monospaced because it ends up as a directory name. */}
        <div className="space-y-1">
          <label
            htmlFor="create-project-name"
            className="text-[11px] font-medium text-muted-foreground block"
          >
            {translate("auto.components.sidebar.AddRepoCreateStep.a8149a3a5a", "Name")}</label>
          <Input
            id="create-project-name"
            value={createName}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder={translate("auto.components.sidebar.AddRepoCreateStep.0ae45b8238", "my-project")}
            className="h-11 text-sm font-mono"
            disabled={isCreating}
            autoFocus
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        {/* The local picker returns client paths; runtime servers browse host paths via RPC. */}
        <CreateProjectLocationField
          createParent={createParent}
          isCreating={isCreating}
          manualParentEntry={manualParentEntry}
          runtimeEnvironmentId={runtimeEnvironmentId}
          onParentChange={onParentChange}
          onPickParent={onPickParent}
          onBrowseServer={() => setBrowsingParent(true)}
        />

        {createError && (
          <p className="text-[11px] text-destructive" role="alert">
            {createError}
          </p>
        )}

        <Button onClick={onCreate} disabled={!canSubmit} size="lg" className="w-full">
          {isCreating ? translate("auto.components.sidebar.AddRepoCreateStep.85085d74d2", "Creating…") : translate("auto.components.sidebar.AddRepoCreateStep.45b7c26034", "Create project")}
        </Button>
      </div>
    </>
  )
}
