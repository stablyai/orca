import type React from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import type { Repo } from '../../../../shared/types'
import {
  getRuntimeServerProjectLabel,
  type RuntimeServerEntry
} from './runtime-server-sidebar-model'

export function RuntimeServerProjects({
  entry,
  onSelectProject
}: {
  entry: RuntimeServerEntry
  onSelectProject: (serverId: string | null, repo: Repo) => void
}): React.JSX.Element {
  const projectLabel = getRuntimeServerProjectLabel(entry.projects)

  if (entry.projects.status === 'loading' && entry.projects.repos.length === 0) {
    return (
      <div className="flex items-center gap-1.5 px-8 py-1.5 text-[11px] text-muted-foreground">
        <Loader2 className="size-3 animate-spin" />
        <span>{projectLabel}</span>
      </div>
    )
  }

  if (entry.projects.status === 'error') {
    return (
      <div className="flex items-start gap-1.5 px-8 py-1.5 text-[11px] text-destructive">
        <AlertTriangle className="mt-0.5 size-3 shrink-0" />
        <span className="min-w-0 truncate">{projectLabel}</span>
      </div>
    )
  }

  if (entry.projects.status === 'idle') {
    return <div className="px-8 py-1.5 text-[11px] text-muted-foreground">{projectLabel}</div>
  }

  if (entry.projects.status === 'ready' && entry.projects.repos.length === 0) {
    return <div className="px-8 py-1.5 text-[11px] text-muted-foreground">No projects.</div>
  }

  return (
    <div className="pb-1">
      {entry.projects.repos.map((repo) => (
        <button
          key={repo.id}
          type="button"
          className="flex h-6 w-full items-center gap-1.5 rounded-md px-8 text-left text-[12px] text-sidebar-foreground hover:bg-sidebar-accent"
          onClick={() => onSelectProject(entry.id, repo)}
        >
          <span className="min-w-0 flex-1 truncate">{repo.displayName}</span>
        </button>
      ))}
    </div>
  )
}
