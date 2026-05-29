import React, { useCallback, useRef, useState } from 'react'
import { GitBranch, GitBranchPlus, Settings } from 'lucide-react'
import { DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { Worktree } from '../../../../shared/types'

type ProjectAddedChoice = 'primary' | 'create' | 'existing'

type ProjectAddedContentProps = {
  repoName: string
  hiddenWorktreeCount: number
  primaryBranchName?: string
  defaultWorktreeName?: string
  onStartPrimaryWorktree: () => void
  onUseExistingWorktrees: () => void
  onCreateWorktree: (name?: string) => void
  onConfigureRepo: () => void
}

type SetupStepProps = ProjectAddedContentProps

const DEFAULT_PROJECT_ADDED_WORKTREE_NAME = 'new-workspace-1'

export function getInitialProjectAddedWorktreeName(
  defaultWorktreeName: string | undefined
): string {
  return defaultWorktreeName?.trim() ? defaultWorktreeName : DEFAULT_PROJECT_ADDED_WORKTREE_NAME
}

export function getProjectAddedPrimaryBranchName(
  primaryWorktree: Pick<Worktree, 'branch'> | null | undefined
): string {
  return primaryWorktree?.branch.replace(/^refs\/heads\//, '').trim() ?? ''
}

export function getProjectAddedChoiceOrder(
  hiddenWorktreeCount: number,
  primaryBranchName?: string
): ProjectAddedChoice[] {
  const choices: ProjectAddedChoice[] = []
  if (primaryBranchName?.trim()) {
    choices.push('primary')
  }
  if (hiddenWorktreeCount > 0) {
    choices.push('existing')
  }
  choices.push('create')
  return choices
}

export function getInitialProjectAddedChoice(
  _hiddenWorktreeCount: number,
  _primaryBranchName?: string
): ProjectAddedChoice {
  return 'create'
}

function formatWorktreeCount(count: number): string {
  return `${count} ${count === 1 ? 'worktree' : 'worktrees'}`
}

type StartChoiceCardProps = {
  value: ProjectAddedChoice
  selected: boolean
  onSelect: () => void
  onArrowNav: () => void
  icon: React.ReactNode
  title: string
  caption: string
}

function StartChoiceCard({
  value,
  selected,
  onSelect,
  onArrowNav,
  icon,
  title,
  caption
}: StartChoiceCardProps): React.JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      tabIndex={selected ? 0 : -1}
      data-choice={value}
      onClick={onSelect}
      onKeyDown={(event) => {
        // Why: this is a true single-choice decision, so arrow keys follow the
        // WAI-ARIA radio pattern instead of acting like ordinary buttons.
        if (
          event.key === 'ArrowLeft' ||
          event.key === 'ArrowRight' ||
          event.key === 'ArrowUp' ||
          event.key === 'ArrowDown'
        ) {
          event.preventDefault()
          onArrowNav()
        } else if (event.key === ' ' || event.key === 'Enter') {
          event.preventDefault()
          onSelect()
        }
      }}
      className={`group flex w-full cursor-pointer items-center gap-3 rounded-md border px-3.5 py-3 text-left text-xs outline-none transition-colors ${
        selected ? 'border-foreground/30 bg-accent' : 'border-border hover:bg-accent/50'
      } focus-visible:ring-[3px] focus-visible:ring-ring/50`}
    >
      <span
        className={`inline-flex size-8 shrink-0 items-center justify-center rounded-md border transition-colors ${
          selected
            ? 'border-foreground/20 bg-background/60 text-foreground'
            : 'border-border/70 bg-background/30 text-muted-foreground group-hover:text-foreground'
        }`}
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] font-medium leading-tight">{title}</span>
        <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
          {caption}
        </span>
      </span>
    </button>
  )
}

export function ProjectAddedContent({
  repoName,
  hiddenWorktreeCount,
  primaryBranchName = '',
  defaultWorktreeName = '',
  onStartPrimaryWorktree,
  onUseExistingWorktrees,
  onCreateWorktree,
  onConfigureRepo
}: ProjectAddedContentProps): React.JSX.Element {
  const [worktreeName, setWorktreeName] = useState(() =>
    getInitialProjectAddedWorktreeName(defaultWorktreeName)
  )
  const [choice, setChoice] = useState<ProjectAddedChoice>(() =>
    getInitialProjectAddedChoice(hiddenWorktreeCount, primaryBranchName)
  )
  const radioGroupRef = useRef<HTMLDivElement>(null)
  const trimmedName = worktreeName.trim()
  const hasHiddenWorktrees = hiddenWorktreeCount > 0
  const normalizedPrimaryBranchName = primaryBranchName.trim()
  const choices = getProjectAddedChoiceOrder(hiddenWorktreeCount, normalizedPrimaryBranchName)
  const selectedChoice = choices.includes(choice) ? choice : (choices[0] ?? 'create')

  const cycleChoice = useCallback(() => {
    const index = choices.indexOf(selectedChoice)
    const nextChoice = choices[(index + 1) % choices.length] ?? 'create'
    setChoice(nextChoice)
    requestAnimationFrame(() => {
      radioGroupRef.current
        ?.querySelector<HTMLButtonElement>(`[data-choice="${nextChoice}"]`)
        ?.focus()
    })
  }, [choices, selectedChoice])

  const handlePrimaryAction = (): void => {
    if (selectedChoice === 'primary') {
      onStartPrimaryWorktree()
      return
    } else if (selectedChoice === 'existing') {
      onUseExistingWorktrees()
      return
    }
    onCreateWorktree(trimmedName || undefined)
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Repo added</DialogTitle>
        <DialogDescription>
          {repoName
            ? `${repoName} is ready. Choose how to start working.`
            : 'Choose how to start working.'}
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-3 pt-1">
        {choices.length > 1 ? (
          <div
            ref={radioGroupRef}
            role="radiogroup"
            aria-label="How to start working"
            className="space-y-2"
          >
            {normalizedPrimaryBranchName ? (
              <StartChoiceCard
                value="primary"
                selected={selectedChoice === 'primary'}
                onSelect={() => setChoice('primary')}
                onArrowNav={cycleChoice}
                icon={<GitBranch className="size-4" />}
                title={`Start from ${normalizedPrimaryBranchName}`}
                caption="Use the primary checkout without creating a worktree."
              />
            ) : null}
            {hasHiddenWorktrees ? (
              <StartChoiceCard
                value="existing"
                selected={selectedChoice === 'existing'}
                onSelect={() => setChoice('existing')}
                onArrowNav={cycleChoice}
                icon={<GitBranch className="size-4" />}
                title="Use existing worktrees"
                caption={`${formatWorktreeCount(hiddenWorktreeCount)} found in this repo.`}
              />
            ) : null}
            <StartChoiceCard
              value="create"
              selected={selectedChoice === 'create'}
              onSelect={() => setChoice('create')}
              onArrowNav={cycleChoice}
              icon={<GitBranchPlus className="size-4" />}
              title="Create a new worktree"
              caption="Start a fresh workspace from this project."
            />
          </div>
        ) : null}

        {selectedChoice === 'create' ? (
          <div className="space-y-1">
            <label
              htmlFor="project-added-worktree-name"
              className="block text-[11px] font-medium text-muted-foreground"
            >
              Workspace name
            </label>
            <Input
              id="project-added-worktree-name"
              value={worktreeName}
              onChange={(event) => setWorktreeName(event.target.value)}
              placeholder="new-workspace"
              className="h-9"
            />
          </div>
        ) : null}
      </div>

      <div className="flex items-center justify-between pt-2">
        <button
          type="button"
          className="inline-flex items-center justify-center gap-1.5 text-xs text-muted-foreground/70 transition-colors hover:text-foreground"
          onClick={onConfigureRepo}
        >
          <Settings className="size-3" />
          Configure repo
        </button>
        <Button type="button" size="sm" onClick={handlePrimaryAction}>
          {selectedChoice === 'primary' ? (
            <>
              <GitBranch className="size-4" />
              Start
            </>
          ) : selectedChoice === 'existing' ? (
            <>
              <GitBranch className="size-4" />
              Use existing
            </>
          ) : (
            <>
              <GitBranchPlus className="size-4" />
              Create worktree
            </>
          )}
        </Button>
      </div>
    </>
  )
}

export function SetupStep(props: SetupStepProps): React.JSX.Element {
  return <ProjectAddedContent {...props} />
}
