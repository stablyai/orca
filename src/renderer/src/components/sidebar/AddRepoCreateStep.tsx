/**
 * Step for AddRepoDialog (orca#763).
 *
 * Split from AddRepoDialog and AddRepoSteps to keep both under the 400-line
 * oxlint limit, following the same pattern as useRemoteRepo.
 */

import React, { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'
import { CornerDownRight, Folder, GitBranch, Home, Pencil } from 'lucide-react'
import { useAppStore } from '@/store'
import { DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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

  const resetCreateState = useCallback(() => {
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
    setIsCreating(true)
    setCreateError(null)
    try {
      const result = await window.api.repos.create({
        parentPath,
        name,
        kind: createKind
      })
      if ('error' in result) {
        setCreateError(result.error)
        return
      }
      const repo = result.repo
      // Upsert into the store before the repos:changed event round-trips,
      // so the next step can find the repo immediately.
      const state = useAppStore.getState()
      const existingIdx = state.repos.findIndex((r) => r.id === repo.id)
      if (existingIdx === -1) {
        useAppStore.setState({ repos: [...state.repos, repo] })
      } else {
        const updated = [...state.repos]
        updated[existingIdx] = repo
        useAppStore.setState({ repos: updated })
      }
      toast.success(createKind === 'git' ? 'Repository created' : 'Folder created', {
        description: repo.displayName
      })
      setAddedRepo(repo)
      if (isGitRepoKind(repo)) {
        await fetchWorktrees(repo.id)
        setStep('setup')
      } else {
        // Plain folders skip the worktree setup step, same as Browse folder.
        closeModal()
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setCreateError(message)
    } finally {
      setIsCreating(false)
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

/** Swap `$HOME/...` for `~/...` and ellipsize the middle when very long. */
function abbreviatePath(path: string): string {
  const home =
    typeof process !== 'undefined' ? (process.env?.HOME ?? process.env?.USERPROFILE ?? '') : ''
  let display = home && path.startsWith(home) ? `~${path.slice(home.length)}` : path
  if (display.length > 42) {
    const tail = display.slice(-24)
    display = `${display.slice(0, 14)}…${tail}`
  }
  return display
}

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
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
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

      <div className="space-y-3.5 pt-1">
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
            <div className="group flex items-center gap-2.5 rounded-md border border-border bg-background/40 h-11 px-3 text-sm">
              <span className="shrink-0 inline-flex items-center justify-center size-7 rounded-md border border-border/70 bg-background/50 text-muted-foreground">
                <Home className="size-3.5" />
              </span>
              <span className="flex-1 truncate font-mono text-[12px]" title={createParent}>
                {abbreviatePath(createParent)}
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

        {/* Preview the composed path, with the name emphasized. */}
        {createParent && trimmedName && (
          <div className="flex items-center gap-2 pl-0.5 text-[12px] text-muted-foreground">
            <CornerDownRight className="size-3.5 shrink-0 text-muted-foreground/60" />
            <span className="font-mono truncate" title={`${createParent}/${trimmedName}`}>
              <span>{abbreviatePath(createParent)}/</span>
              <span className="text-foreground font-medium">{trimmedName}</span>
            </span>
          </div>
        )}

        {createError && (
          <p className="text-[11px] text-destructive" role="alert">
            {createError}
          </p>
        )}

        <Button onClick={onCreate} disabled={!canSubmit} size="lg" className="w-full">
          {isCreating ? 'Creating…' : createKind === 'git' ? 'Create repository' : 'Create folder'}
        </Button>
      </div>
    </>
  )
}
