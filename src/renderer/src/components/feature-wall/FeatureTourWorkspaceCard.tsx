import type { JSX } from 'react'
import { cn } from '@/lib/utils'
import { ClaudeIcon, OpenCodeGoIcon } from '../status-bar/icons'
import { CodexInlineIcon, WorkingSpinner } from './feature-tour-preview-glyphs'

export type FeatureTourWorkspaceCardAgent = {
  kind: 'claude' | 'codex' | 'opencode-go'
  barWidth: string
  state: 'working' | 'done'
}

export function FeatureTourWorkspaceCard({
  status,
  title,
  agents
}: {
  status: 'working' | 'done'
  title: string
  agents: readonly FeatureTourWorkspaceCardAgent[]
}): JSX.Element {
  return (
    <div
      className={cn(
        'flex min-w-0 flex-col rounded-md border bg-background px-3 py-2',
        status === 'done' ? 'border-border/70' : 'border-border'
      )}
    >
      <div className="flex items-center gap-2">
        {status === 'working' ? (
          <WorkingSpinner />
        ) : (
          <span className="size-2 rounded-full bg-emerald-500" />
        )}
        <span
          className={cn(
            'truncate text-[16.5px] leading-none',
            status === 'done' ? 'text-muted-foreground' : 'font-medium text-foreground'
          )}
        >
          {title}
        </span>
      </div>
      <div className="mt-2 flex flex-col gap-1.5 pl-3.5">
        {agents.map((agent, idx) => (
          <div key={idx} className="flex items-center gap-1.5">
            {agent.state === 'working' ? (
              <WorkingSpinner size="xs" />
            ) : (
              <span className="inline-block size-1.5 rounded-full bg-emerald-500" />
            )}
            {agent.kind === 'claude' ? (
              <ClaudeIcon size={13} />
            ) : agent.kind === 'codex' ? (
              <CodexInlineIcon />
            ) : (
              <OpenCodeGoIcon size={13} />
            )}
            <span className="h-2 rounded-full bg-foreground/15" style={{ width: agent.barWidth }} />
          </div>
        ))}
      </div>
    </div>
  )
}
