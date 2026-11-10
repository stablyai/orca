// The setup panel's GitHub row (cloud-start D1–D3), stacked like the panel's tracker rows:
// line 1 icon · label · status word or action; line 2 the detail with a muted note under it.
// Rendered inside w2-lifecycle's Set up Orca Cloud panel; its model is orcaCloudGitHubSetupRow
// (lib/orca-cloud/orca-cloud-github-setup-row.ts).
import { CircleCheck, CircleDashed, Github, Loader2, SquareArrowOutUpRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import type { OrcaCloudGitHubSetupRow as RowModel } from '@/lib/orca-cloud/orca-cloud-github-setup-row'

function RowIcon({ state }: { state: RowModel['step']['state'] }): React.JSX.Element {
  switch (state) {
    case 'done':
      return <CircleCheck className="size-4 shrink-0 text-muted-foreground" aria-hidden />
    case 'pending':
      // Reduced motion stops the spin; the "Requested" status word carries the state.
      return (
        <Loader2
          className="size-4 shrink-0 text-muted-foreground motion-safe:animate-spin"
          aria-hidden
        />
      )
    case 'failed':
      return <Github className="size-4 shrink-0 text-muted-foreground" aria-hidden />
    case 'needed':
    case 'active':
      return <CircleDashed className="size-4 shrink-0 text-muted-foreground" aria-hidden />
  }
}

export function OrcaCloudGitHubSetupRow({ row }: { row: RowModel }): React.JSX.Element {
  const checking = row.step.state === 'active' && !row.step.detail
  const attention = row.step.state === 'needed' || row.step.state === 'failed'
  const action = row.action
  return (
    <div
      className="flex flex-col items-start gap-0.5 rounded-md border border-border px-3 py-2.5 text-sm"
      aria-label={[row.label, row.step.detail, row.status].filter(Boolean).join(', ')}
      role="group"
    >
      <div className="flex min-h-8 w-full items-center gap-3">
        <RowIcon state={row.step.state} />
        <span className="min-w-0 flex-1 text-foreground">{row.label}</span>
        {action ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void window.api.shell.openUrl(action.url).catch(() => {})}
          >
            {action.label}
            <SquareArrowOutUpRight aria-hidden />
          </Button>
        ) : row.status ? (
          <span className="shrink-0 text-muted-foreground">{row.status}</span>
        ) : null}
      </div>
      {/* Indented to the label: icon (16px) + gap (12px). */}
      <div className="flex w-full min-w-0 flex-col items-start pl-7">
        {checking ? (
          <Skeleton className="h-4 w-48" />
        ) : (
          <>
            {row.step.detail ? (
              <p className={cn(attention ? 'text-status-warning-text' : 'text-foreground')}>
                {row.step.detail}
              </p>
            ) : null}
            {row.note ? <p className="text-muted-foreground">{row.note}</p> : null}
          </>
        )}
      </div>
    </div>
  )
}
