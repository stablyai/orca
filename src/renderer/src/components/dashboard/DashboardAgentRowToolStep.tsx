import { Wrench } from 'lucide-react'
import { cn } from '@/lib/utils'

type DashboardAgentRowToolStepProps = {
  expanded: boolean
  showsTool: boolean
  /** Hold the slot open while tool metadata is still in flight — see the empty branch below. */
  reservesHeight: boolean
  toolName: string
  toolInput: string
  /** Said in the step's place: a person's Stop ending the turn (`agentRowStoppingLabel`). */
  statusLabel?: string | null
}

export function DashboardAgentRowToolStep({
  expanded,
  showsTool,
  reservesHeight,
  toolName,
  toolInput,
  statusLabel = null
}: DashboardAgentRowToolStepProps): React.JSX.Element | null {
  if (statusLabel) {
    return (
      <div
        data-agent-row-tool-slot=""
        className="mt-0.5 min-w-0 truncate pl-5 text-[10px] leading-snug text-muted-foreground/70"
      >
        {statusLabel}
      </div>
    )
  }
  if (!showsTool || (!toolName && !reservesHeight)) {
    return null
  }

  return (
    <div
      data-agent-row-tool-slot=""
      className="mt-0.5 min-w-0 pl-5 text-[10px] leading-snug text-muted-foreground/70"
    >
      {toolName ? (
        <>
          <div
            data-agent-row-tool-header="true"
            className={cn(
              'flex h-[1lh] min-w-0 items-center gap-1',
              !expanded && 'overflow-hidden'
            )}
          >
            <Wrench className="size-2.5 shrink-0" />
            <code className="shrink-0 font-mono text-[10px]">{toolName}</code>
            {!expanded && toolInput ? (
              <span className="min-w-0 truncate text-muted-foreground/60" title={toolInput}>
                {toolInput}
              </span>
            ) : null}
          </div>
          {toolInput ? (
            <div
              className={cn(
                'grid transition-[grid-template-rows,margin-top] duration-200 ease-out',
                expanded ? 'mt-0.5 grid-rows-[1fr]' : 'grid-rows-[0fr]'
              )}
            >
              <pre className="min-h-0 overflow-hidden whitespace-pre-wrap break-words font-mono text-[10px] text-muted-foreground/60">
                {toolInput}
              </pre>
            </div>
          ) : null}
        </>
      ) : (
        <span data-agent-row-tool-placeholder="true" aria-hidden className="block h-[1lh]" />
      )}
    </div>
  )
}
