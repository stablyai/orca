// The plans page's surrounding states: the value props, the loading skeleton and the load error.
import { Cloud, KeyRound, Zap } from 'lucide-react'
import { InlineError } from '@/components/ui/inline-error'
import { Skeleton } from '@/components/ui/skeleton'
import { useTranslate } from '@/i18n/use-translate'

export function ValueProps(): React.JSX.Element {
  const t = useTranslate()
  // Same promises as the marketing site's /cloud page.
  const items = [
    {
      icon: Cloud,
      title: t('auto.components.billing.plans.vpRunningTitle', 'Agents keep running'),
      body: t(
        'auto.components.billing.plans.vpRunningBody2',
        'Sandboxes keep working while you are away and report back when they finish.'
      )
    },
    {
      icon: Zap,
      title: t('auto.components.billing.plans.vpWakeTitle', 'Wake in seconds'),
      body: t(
        'auto.components.billing.plans.vpWakeBody3',
        'Idle sandboxes sleep to save sandbox hours and wake with your files as you left them.'
      )
    },
    {
      icon: KeyRound,
      title: t('auto.components.billing.plans.vpSecretsTitleEdge', 'Agent keys stay out of the sandbox'),
      body: t(
        'auto.components.billing.plans.vpSecretsBodyEdge',
        'Model API keys and agent sign-ins are swapped in at the network edge. Other secrets are environment variables.'
      )
    }
  ]
  return (
    <ul className="grid gap-4 sm:grid-cols-3 [@media(max-height:900px)]:hidden">
      {items.map((item) => (
        <li key={item.title} className="flex items-start gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <item.icon className="size-4" />
          </span>
          <div className="space-y-0.5">
            <p className="text-sm font-medium">{item.title}</p>
            <p className="text-xs leading-5 text-muted-foreground text-pretty">{item.body}</p>
          </div>
        </li>
      ))}
    </ul>
  )
}

function SkeletonLine({ className }: { className: string }): React.JSX.Element {
  return <Skeleton className={className} />
}

function SkeletonCard({
  lines,
  seatRow = false
}: {
  lines: number
  seatRow?: boolean
}): React.JSX.Element {
  return (
    <div className="flex h-full flex-col gap-5 rounded-xl border border-border bg-card p-5 shadow-xs">
      <SkeletonLine className="h-4 w-24" />
      <div className="space-y-2">
        <SkeletonLine className="h-8 w-32" />
        <SkeletonLine className="h-3 w-28" />
      </div>
      {seatRow ? <SkeletonLine className="h-9 w-full" /> : null}
      <div className="flex-1 space-y-3">
        {Array.from({ length: lines }, (_, index) => (
          <SkeletonLine key={index} className={index % 2 ? 'h-3 w-4/5' : 'h-3 w-11/12'} />
        ))}
      </div>
      <div className="min-h-[6rem] space-y-2 border-t border-border/60 pt-4">
        <SkeletonLine className="h-9 w-full" />
        <SkeletonLine className="mx-auto h-3 w-3/5" />
      </div>
    </div>
  )
}

/** Same geometry as the loaded page (value props, toggle, two cards) so nothing jumps (review M4). */
export function PlansSkeleton(): React.JSX.Element {
  const t = useTranslate()
  return (
    <div
      className="space-y-6"
      role="status"
      aria-label={t('auto.components.billing.plans.loading', 'Loading plans…')}
    >
      <ValueProps />
      <div className="flex justify-center">
        <Skeleton shape="circle" className="h-8 w-72" />
      </div>
      <div className="grid items-stretch gap-4 md:grid-cols-2">
        <SkeletonCard lines={5} seatRow />
        <SkeletonCard lines={4} />
      </div>
      <div className="mx-auto max-w-xl space-y-1.5">
        <Skeleton className="mx-auto h-3 w-2/3" />
        <Skeleton className="mx-auto h-3 w-5/6" />
      </div>
    </div>
  )
}

export function PlansLoadError({ onRetry }: { onRetry: () => void }): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="space-y-6">
      <ValueProps />
      <InlineError
        className="mx-auto my-16 max-w-md"
        title={t('auto.components.billing.plans.loadFailedTitle', 'Plans didn’t load')}
        detail={t(
          'auto.components.billing.plans.loadFailed2',
          'Couldn’t load plans. Try again in a moment.'
        )}
        retryLabel={t('auto.components.billing.plans.retry', 'Try again')}
        onRetry={onRetry}
      />
    </div>
  )
}
