import React from 'react'
import { CircleCheck, CircleDashed, CircleX, GitPullRequest, Minus } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { CloudOfflinePr } from '../../../../../shared/hosted-sandbox/cloud-workspace-offline-api'
import {
  checksLabel,
  checksTone,
  prStateLabel,
  type ChecksTone
} from './cloud-read-snapshot-format'

const TONE: Record<ChecksTone, { icon: typeof CircleCheck; className: string }> = {
  success: { icon: CircleCheck, className: 'text-status-success' },
  failure: { icon: CircleX, className: 'text-destructive' },
  pending: { icon: CircleDashed, className: 'text-status-warning-text' },
  neutral: { icon: Minus, className: 'text-muted-foreground' }
}

/** The workspace's pull request as of its last sleep: a link out plus its checks. */
export function CloudReadPrLink({ pr }: { pr: CloudOfflinePr }): React.JSX.Element {
  const t = useTranslate()
  const tone = checksTone(pr.checksStatus)
  const Icon = TONE[tone].icon
  const checks = checksLabel(tone, t)
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border px-3 py-2 text-xs"
      data-cloud-read-pr=""
    >
      <GitPullRequest className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <a
        href={pr.url}
        onClick={(event) => {
          // Links open in the browser, never inside the app window.
          event.preventDefault()
          void window.api.shell.openUrl(pr.url).catch(() => undefined)
        }}
        className="min-w-0 flex-1 truncate rounded-sm font-medium text-foreground underline-offset-2 outline-none hover:underline focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-focus-ring"
      >
        {t('components.orcaCloud.read.prTitle', '#{{number}} {{title}}', {
          number: pr.number,
          title: pr.title
        })}
      </a>
      <span className="shrink-0 text-muted-foreground">{prStateLabel(pr.state, t)}</span>
      <span className={cn('flex shrink-0 items-center gap-1', TONE[tone].className)}>
        <Icon className="size-3.5" aria-hidden />
        <span>{checks}</span>
        {pr.checksSummary ? (
          <span className="text-muted-foreground">· {pr.checksSummary}</span>
        ) : null}
      </span>
    </div>
  )
}
