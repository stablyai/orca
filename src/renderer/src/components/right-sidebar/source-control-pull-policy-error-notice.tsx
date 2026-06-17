import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { Check, Copy, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

const PULL_POLICY_ERROR_PREFIX = 'Pull needs a Git pull policy for divergent branches.'

const PULL_POLICY_OPTIONS = [
  {
    label: 'Merge',
    description: 'Create a merge commit when local and remote both changed.',
    command: 'git config pull.rebase false'
  },
  {
    label: 'Rebase',
    description: 'Replay local commits on top of the remote branch.',
    command: 'git config pull.rebase true'
  },
  {
    label: 'Fast-forward only',
    description: 'Only pull when no merge or rebase is needed.',
    command: 'git config pull.ff only'
  }
] as const

export function isPullPolicyRemoteActionError(message: string): boolean {
  return message.startsWith(PULL_POLICY_ERROR_PREFIX)
}

type PullPolicyRemoteActionNoticeProps = {
  id: string
}

export function PullPolicyRemoteActionNotice({
  id
}: PullPolicyRemoteActionNoticeProps): React.JSX.Element {
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null)

  useEffect(() => {
    if (!copiedCommand) {
      return
    }
    const timeout = window.setTimeout(() => setCopiedCommand(null), 1400)
    return () => window.clearTimeout(timeout)
  }, [copiedCommand])

  const handleCopyCommand = useCallback((command: string) => {
    void window.api.ui.writeClipboardText(command)
    setCopiedCommand(command)
  }, [])

  return (
    <div
      id={id}
      role="alert"
      aria-live="polite"
      className="mt-2 min-w-0 overflow-hidden rounded-lg border border-destructive/20 bg-card text-card-foreground shadow-xs"
    >
      <div className="h-0.5 bg-destructive/70" aria-hidden="true" />
      <div className="space-y-2.5 px-2.5 py-2.5">
        <div className="grid min-w-0 grid-cols-[1rem_minmax(0,1fr)] gap-1.5">
          <span className="mt-px inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <TriangleAlert className="size-3" aria-hidden="true" />
          </span>
          <div className="min-w-0 space-y-1">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span className="text-xs font-semibold text-foreground">Pull needs a policy</span>
              <span className="shrink-0 rounded-full bg-destructive/10 px-1.5 py-px text-[10px] leading-4 font-semibold text-destructive">
                Diverged
              </span>
            </div>
            <p className="text-[11px] leading-4 text-muted-foreground">
              This branch has local and remote commits. Run one command in this worktree or on the
              SSH host, then try Pull or Sync again.
            </p>
          </div>
        </div>
        <div className="space-y-1.5">
          {PULL_POLICY_OPTIONS.map((option) => {
            const copied = copiedCommand === option.command
            return (
              <div
                key={option.command}
                className="rounded-md border border-border bg-muted/30 px-2 py-1.5"
              >
                <div className="flex min-w-0 items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-[11px] leading-4 font-semibold text-foreground">
                      {option.label}
                    </div>
                    <p className="text-[11px] leading-4 text-muted-foreground">
                      {option.description}
                    </p>
                  </div>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="mt-0.5 shrink-0"
                        aria-label={`Copy ${option.label.toLowerCase()} pull policy command`}
                        onClick={() => handleCopyCommand(option.command)}
                      >
                        {copied ? (
                          <Check className="size-3" aria-hidden="true" />
                        ) : (
                          <Copy className="size-3" aria-hidden="true" />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top" sideOffset={4}>
                      {copied ? 'Copied' : 'Copy command'}
                    </TooltipContent>
                  </Tooltip>
                </div>
                <code className="mt-1 block rounded border border-border bg-background px-1.5 py-1 font-mono text-[11px] leading-4 break-words text-foreground">
                  {option.command}
                </code>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
