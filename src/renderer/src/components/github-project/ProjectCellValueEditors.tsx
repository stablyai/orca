import React, { useState } from 'react'
import { Plus } from 'lucide-react'
import { Input } from '@/components/ui/input'
import type { GitHubProjectLabel, GitHubProjectUser } from '../../../../shared/github/project-types'
import { chipStyle, labelChipColors } from './project-cell-chip-colors'

export function EmptyProjectCell({ label }: { label: string }): React.JSX.Element {
  return (
    <span className="inline-flex h-6 max-w-full items-center gap-1 rounded-md border border-dashed border-border/70 bg-input/30 px-2 text-xs text-muted-foreground/80 shadow-xs hover:border-border hover:bg-accent hover:text-accent-foreground dark:bg-input/30 dark:hover:bg-input/50">
      <Plus className="size-3 shrink-0" />
      <span className="truncate">{label}</span>
    </span>
  )
}

export function ProjectTextCell({
  value,
  editable,
  numeric,
  placeholder,
  onCommit
}: {
  value: string
  editable: boolean
  numeric?: boolean
  placeholder: string
  onCommit: (next: string) => void
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  if (!editable) {
    return <span className="truncate text-xs">{value}</span>
  }
  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          setDraft(value)
          setEditing(true)
        }}
        className="flex h-full w-full cursor-pointer items-center px-1 text-left text-xs hover:underline"
      >
        {value || <EmptyProjectCell label={placeholder} />}
      </button>
    )
  }
  const commit = (): void => {
    setEditing(false)
    if (draft !== value) {
      onCommit(draft)
    }
  }
  return (
    <Input
      autoFocus
      type={numeric ? 'number' : 'text'}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          commit()
        } else if (event.key === 'Escape') {
          event.preventDefault()
          setEditing(false)
          setDraft(value)
        }
      }}
      className="h-6 text-xs"
    />
  )
}

export function ProjectDateCell({
  value,
  editable,
  label,
  onCommit
}: {
  value: string
  editable: boolean
  label: string
  onCommit: (next: string) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(value ?? '')
  if (!editable) {
    return <span className="text-xs">{value}</span>
  }
  return (
    <input
      type="date"
      aria-label={label}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft !== value) {
          onCommit(draft)
        }
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          event.currentTarget.blur()
        } else if (event.key === 'Escape') {
          event.preventDefault()
          setDraft(value)
          event.currentTarget.blur()
        }
      }}
      className="h-6 cursor-pointer rounded border border-border/50 bg-background px-1 text-xs"
    />
  )
}

export function ProjectLabelChip({ label }: { label: GitHubProjectLabel }): React.JSX.Element {
  return (
    <span
      className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none text-[var(--github-project-chip-fg-light)] dark:text-[var(--github-project-chip-fg-dark)]"
      style={chipStyle(labelChipColors(label.color))}
    >
      {label.name}
    </span>
  )
}

export function ProjectUserChip({ user }: { user: GitHubProjectUser }): React.JSX.Element {
  if (user.avatarUrl) {
    return (
      <img
        src={user.avatarUrl}
        alt={user.login}
        title={user.login}
        className="size-5 rounded-full border border-border/40"
      />
    )
  }
  return (
    <span
      title={user.login}
      className="inline-flex size-5 items-center justify-center rounded-full bg-muted text-[10px]"
    >
      {user.login.slice(0, 1).toUpperCase()}
    </span>
  )
}
