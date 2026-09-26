import type { ReactNode } from 'react'
import type {
  PerforceEntry,
  PerforceFileAction
} from '../../../../../shared/perforce/perforce-types'

const ACTION_LABELS: Partial<Record<PerforceFileAction, string>> = {
  add: 'A',
  edit: 'M',
  delete: 'D',
  branch: 'B',
  integrate: 'I',
  'move/add': 'R',
  'move/delete': 'D'
}

const ACTION_COLORS: Partial<Record<PerforceFileAction, string>> = {
  add: 'var(--git-decoration-added)',
  edit: 'var(--git-decoration-modified)',
  delete: 'var(--git-decoration-deleted)',
  'move/add': 'var(--git-decoration-renamed)',
  'move/delete': 'var(--git-decoration-deleted)'
}

export function PerforceFileRow({
  entry,
  onOpen,
  actions
}: {
  entry: PerforceEntry
  onOpen: () => void
  actions: ReactNode
}) {
  const slash = entry.path.lastIndexOf('/')
  const name = entry.path.slice(slash + 1)
  const dir = slash === -1 ? '' : entry.path.slice(0, slash)
  const label = entry.group === 'new' ? 'U' : (ACTION_LABELS[entry.action] ?? '?')
  const color =
    entry.group === 'new' ? 'var(--git-decoration-untracked)' : ACTION_COLORS[entry.action]
  return (
    <div className="group flex items-center gap-1 px-2 py-0.5 text-[13px] hover:bg-accent">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
        onClick={onOpen}
        title={entry.depotPath ?? entry.path}
      >
        <span className="w-3 shrink-0 text-center text-[11px] font-semibold" style={{ color }}>
          {label}
        </span>
        <span className="truncate">{name}</span>
        {dir ? <span className="truncate text-xs text-muted-foreground">{dir}</span> : null}
      </button>
      <div className="flex shrink-0 items-center opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
        {actions}
      </div>
    </div>
  )
}
