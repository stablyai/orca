import React from 'react'
import { Circle } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { DockerContainerSummary } from '../../../../shared/docker-types'

export function DockerResourceTree({
  containers,
  selectedId,
  onSelect
}: {
  containers: DockerContainerSummary[]
  selectedId: string | null
  onSelect: (id: string) => void
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-0.5 p-2">
      <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
        Containers
      </div>
      {containers.length === 0 ? (
        <div className="px-2 py-1 text-xs text-muted-foreground">No containers.</div>
      ) : (
        containers.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => onSelect(c.id)}
            data-current={c.id === selectedId ? 'true' : undefined}
            className={cn(
              'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-accent',
              c.id === selectedId && 'bg-accent'
            )}
          >
            <Circle
              className={cn(
                'size-2 shrink-0',
                // Why: use semantic design tokens (text-primary / text-muted-foreground)
                // not git-decoration-* colors — those are reserved for git status indicators.
                c.state === 'running' ? 'fill-primary text-primary' : 'fill-muted-foreground text-muted-foreground'
              )}
            />
            <span className="flex-1 truncate">{c.names[0] ?? c.id.slice(0, 12)}</span>
            <span className="truncate text-xs text-muted-foreground">{c.image}</span>
          </button>
        ))
      )}
    </div>
  )
}
