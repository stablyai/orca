import { GitCommitHorizontal, Info, PackageOpen, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useTranslate } from '@/i18n/use-translate'
import type { StalenessBannerCopy } from './cloud-environment-copy'

export function StalenessBanner({
  copy,
  canAdmin,
  building,
  onRebuild
}: {
  copy: StalenessBannerCopy
  canAdmin: boolean
  /** A build is already running: the rebuild action would be refused. */
  building: boolean
  onRebuild: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const Icon =
    copy.tone === 'prominent' ? PackageOpen : copy.tone === 'info' ? Info : GitCommitHorizontal
  if (copy.tone === 'subtle') {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
        <Icon aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1">{copy.message}</span>
        {canAdmin ? (
          <Button type="button" variant="outline" size="xs" disabled={building} onClick={onRebuild}>
            <RefreshCw />
            {t('cloudEnvironment.staleness.rebuild', 'Rebuild')}
          </Button>
        ) : null}
      </p>
    )
  }
  return (
    <div
      role="status"
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-3 py-2.5 motion-safe:animate-in motion-safe:fade-in',
        copy.tone === 'prominent'
          ? 'border-status-warning-border bg-status-warning-background text-status-warning-text'
          : 'border-border bg-muted/40 text-foreground'
      )}
    >
      <Icon aria-hidden className="size-4 shrink-0" />
      <p className="min-w-0 flex-1 text-sm">{copy.message}</p>
      {canAdmin && copy.rebuild ? (
        <Button
          type="button"
          size="xs"
          variant={copy.tone === 'prominent' ? 'default' : 'outline'}
          disabled={building}
          onClick={onRebuild}
        >
          <RefreshCw />
          {t('cloudEnvironment.staleness.rebuild', 'Rebuild')}
        </Button>
      ) : null}
    </div>
  )
}
