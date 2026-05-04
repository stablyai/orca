/**
 * Step for AddRepoDialog (orca#763).
 *
 * Split from AddRepoDialog and AddRepoSteps to keep both under the 400-line
 * oxlint limit, following the same pattern as useRemoteRepo.
 */

import React, { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Folder, GitBranch, Home, Pencil } from 'lucide-react'
import { useAppStore } from '@/store'
import { DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import type { Repo } from '../../../../shared/types'

type DialogStep = 'add' | 'clone' | 'remote' | 'create' | 'setup'
type RepoKind = 'git' | 'folder'

export function useCreateRepo(
  fetchWorktrees: (repoId: string) => Promise<void>,
  setStep: (step: DialogStep) => void,
  setAddedRepo: (repo: Repo | null) => void,
  closeModal: () => void
) {
  const [createName, setCreateName] = useState('')
  const [createParent, setCreateParent] = useState('')
  const [createKind, setCreateKind] = useState<RepoKind>('git')
  const [createError, setCreateError] = useState<string | null>(null)
  const [isCreating, setIsCreating] = useState(false)

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
    const dir = await window.api.repos.pickDirectory()
    if (dir) {
      setCreateParent(dir)
      setCreateError(null)
    }
  }, [])

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
      const result = await window.api.repos.create({
        parentPath,
        name,
        kind: createKind
      })
      // Why: if the user closed the dialog or clicked Back mid-create,
      // createGenRef was bumped by resetCreateState. Ignore stale results.
      if (gen !== createGenRef.current) {
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
        toast.info('Project already added', {
          description: repo.displayName
        })
      } else {
        toast.success('Project created', {
          description: repo.displayName
        })
      }
      if (isGitRepoKind(repo)) {
        // Why: setAddedRepo only drives the git "setup" step; the folder
        // branch closes the dialog, which resets addedRepo to null anyway.
        setAddedRepo(repo)
        await fetchWorktrees(repo.id)
        if (gen !== createGenRef.current) {
          return
        }
        setStep('setup')
      } else {
        // Why: without activating the new folder, the dialog closes and users
        // see no change. Matches addNonGitFolder's behavior in the store slice.
        await fetchWorktrees(repo.id)
        if (gen !== createGenRef.current) {
          return
        }
        const folderWorktree = useAppStore.getState().worktreesByRepo[repo.id]?.[0]
        if (folderWorktree) {
          activateAndRevealWorktree(folderWorktree.id)
        }
        closeModal()
      }
    } catch (err) {
      if (gen !== createGenRef.current) {
        return
      }
      const message = err instanceof Error ? err.message : String(err)
      setCreateError(message)
    } finally {
      // Why: only clear the loading state if this invocation is still current;
      // a superseded create must not flip the flag back off for a new flow.
      if (gen === createGenRef.current) {
        setIsCreating(false)
      }
    }
  }, [createName, createParent, createKind, fetchWorktrees, setStep, setAddedRepo, closeModal])

  return {
    createName,
    createParent,
    createKind,
    createError,
    isCreating,
    setCreateName,
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
  onNameChange: (value: string) => void
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
  onNameChange,
  onKindChange,
  onPickParent,
  onCreate
}: CreateStepProps): React.JSX.Element {
  const radioGroupRef = useRef<HTMLDivElement>(null)

  // Arrow keys cycle selection within the radiogroup (WAI-ARIA radio pattern).
  const cycleKind = useCallback(() => {
    const next = createKind === 'git' ? 'folder' : 'git'
    onKindChange(next)
    requestAnimationFrame(() => {
      const nextEl = radioGroupRef.current?.querySelector<HTMLButtonElement>(
        `[data-kind="${next}"]`
      )
      nextEl?.focus()
    })
  }, [createKind, onKindChange])

  const trimmedName = createName.trim()
  const canSubmit = trimmedName.length > 0 && createParent.trim().length > 0 && !isCreating

  return (
    <>
      <DialogHeader>
        <DialogTitle>Start a new project</DialogTitle>
        <DialogDescription>
          Create a Git repository or a plain folder and open it in Orca.
        </DialogDescription>
      </DialogHeader>

      {/* Why: DialogContent is a CSS grid; grid items default to min-width:auto
        (= content size), so a long path inside the Location row would blow out
        the dialog width even with flex + truncate on the row itself. min-w-0
        here caps the grid track at the dialog's max-width. */}
      <div className="space-y-3.5 pt-1 min-w-0">
        {/* Kind toggle. Real radiogroup so screen readers announce it as a choice. */}
        <div
          ref={radioGroupRef}
          role="radiogroup"
          aria-label="Project kind"
          className="grid grid-cols-2 gap-2"
        >
          <KindCard
            kind="git"
            selected={createKind === 'git'}
            disabled={isCreating}
            onSelect={() => onKindChange('git')}
            onArrowNav={cycleKind}
            icon={<GitBranch className="size-4" />}
            title="Git repository"
            caption="Initializes an empty Git repo"
          />
          <KindCard
            kind="folder"
            selected={createKind === 'folder'}
            disabled={isCreating}
            onSelect={() => onKindChange('folder')}
            onArrowNav={cycleKind}
            icon={<Folder className="size-4" />}
            title="Folder"
            caption="Create a new folder"
          />
        </div>

        {/* Name. Monospaced because it ends up as a directory name. */}
        <div className="space-y-1">
          <label
            htmlFor="create-project-name"
            className="text-[11px] font-medium text-muted-foreground block"
          >
            Name
          </label>
          <Input
            id="create-project-name"
            value={createName}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder="my-project"
            className="h-11 text-sm font-mono"
            disabled={isCreating}
            autoFocus
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        {/* Location. The "Choose…" button morphs into a summary + Change once picked. */}
        <div className="space-y-1">
          <span className="text-[11px] font-medium text-muted-foreground block">Location</span>

          {createParent ? (
            <div className="group flex items-center gap-2.5 rounded-md border border-border bg-background/40 h-11 min-w-0 px-3 text-sm">
              <span className="shrink-0 inline-flex items-center justify-center size-7 rounded-md border border-border/70 bg-background/50 text-muted-foreground">
                <Home className="size-3.5" />
              </span>
              <span className="flex-1 min-w-0 truncate font-mono text-[12px]" title={createParent}>
                {createParent}
              </span>
              <button
                type="button"
                onClick={onPickParent}
                disabled={isCreating}
                className="shrink-0 inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer disabled:cursor-not-allowed"
                aria-label="Change parent folder"
              >
                <Pencil className="size-3" />
                Change
              </button>
            </div>
          ) : (
            <Button
              type="button"
              variant="outline"
              onClick={onPickParent}
              disabled={isCreating}
              className="w-full h-11 justify-start text-sm text-muted-foreground font-normal gap-2.5"
            >
              <span className="shrink-0 inline-flex items-center justify-center size-7 rounded-md border border-border/70 bg-background/40">
                <Folder className="size-3.5" />
              </span>
              Choose parent folder…
            </Button>
          )}
        </div>

        {createError && (
          <p className="text-[11px] text-destructive" role="alert">
            {createError}
          </p>
        )}

        <Button onClick={onCreate} disabled={!canSubmit} size="lg" className="w-full">
          {isCreating ? 'Creating…' : 'Create project'}
        </Button>
      </div>
    </>
  )
}
