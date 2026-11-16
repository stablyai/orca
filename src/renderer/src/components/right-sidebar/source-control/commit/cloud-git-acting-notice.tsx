import React from 'react'
import { Github } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import {
  gitActingCaveat,
  gitActingLine,
  type CloudGitActing
} from '@/components/cloud-workspaces/cloud-git-acting-copy'
import { useCloudGitActor } from '@/components/cloud-workspaces/use-cloud-git-actor'

/**
 * Under Commit/Push in a cloud workspace: who pushes and PRs go out as right now, and,
 * when it falls back to Orca's bot for a viewer who hasn't connected GitHub, Connect GitHub. The
 * only place that action shows; the people tooltip just says who.
 */
export function CloudGitActingNoticeView({
  answer,
  onConnect
}: {
  answer: CloudGitActing | null
  onConnect: () => void
}): React.JSX.Element | null {
  const t = useTranslate()
  const line = gitActingLine(answer, t)
  if (!line) {
    return null
  }
  return (
    <div
      data-cloud-git-acting
      className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-2xs text-muted-foreground"
    >
      <Github aria-hidden className="size-3 shrink-0" />
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            className="min-w-0 flex-1 outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            {line.text}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-72">
          {gitActingCaveat(t)}
        </TooltipContent>
      </Tooltip>
      {line.connect ? (
        <Button
          type="button"
          variant="link"
          size="statusAction"
          className="shrink-0"
          onClick={onConnect}
        >
          {t('cloudGitActing.connect', 'Connect GitHub')}
        </Button>
      ) : null}
    </div>
  )
}

export function CloudGitActingNotice({
  worktreeId
}: {
  worktreeId: string | null
}): React.JSX.Element | null {
  const answer = useCloudGitActor(worktreeId)
  // The browser OAuth finishes elsewhere; the actor is re-read when Orca is focused again.
  const connect = (): void =>
    void Promise.resolve()
      .then(() => window.api.orcaCloudWorkspace.connectGitHubUser())
      .catch(() => null)
  return <CloudGitActingNoticeView answer={answer} onConnect={connect} />
}
