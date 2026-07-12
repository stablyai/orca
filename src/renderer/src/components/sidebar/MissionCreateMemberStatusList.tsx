import React from 'react'
import { CircleAlert, CircleCheck, LoaderCircle } from 'lucide-react'

export type MissionCreateMemberStatus = {
  repoId: string
  repoName: string
  state: 'pending' | 'created' | 'failed'
  error?: string
}

export function MissionCreateMemberStatusList({
  entries
}: {
  entries: MissionCreateMemberStatus[]
}): React.JSX.Element {
  return (
    <ul className="max-h-48 space-y-1.5 overflow-y-auto scrollbar-sleek">
      {entries.map((entry) => (
        <li key={entry.repoId} className="flex items-start gap-2 text-xs">
          {entry.state === 'pending' ? (
            <LoaderCircle className="mt-0.5 size-3.5 shrink-0 animate-spin text-muted-foreground" />
          ) : entry.state === 'created' ? (
            <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" />
          )}
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-foreground">{entry.repoName}</span>
            {entry.error ? (
              <span className="break-words text-[11px] text-destructive">{entry.error}</span>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  )
}
