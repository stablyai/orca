import React from 'react'
import { Loader2, MemoryStick, RotateCw, Unplug, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type { CloudOomEvent } from '../../../../shared/hosted-sandbox/cloud-workspace-api'

export type CloudNoticeKind = { kind: 'unresponsive' } | { kind: 'oom'; oom: CloudOomEvent }

/**
 * A quiet card in the workspace's top-right corner: the VM stopped answering, or a process ran out
 * of memory. Both offer Restart (same disk; interrupted agents continue). Doesn't block the panes.
 */
export function CloudWorkspaceNotice({
  notice,
  restarting,
  onRestart,
  onDismiss
}: {
  notice: CloudNoticeKind
  restarting: boolean
  onRestart: () => void
  onDismiss?: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const isOom = notice.kind === 'oom'
  const victim = isOom ? notice.oom.victim : null
  const title = isOom
    ? victim
      ? t('orcaCloudWorkspace.oom.titleNamed', 'A process ({{name}}) ran out of memory', { name: victim })
      : t('orcaCloudWorkspace.oom.title', 'A process ran out of memory')
    : t('orcaCloudWorkspace.unresponsive.title', 'This cloud workspace isn’t responding')
  const detail = isOom
    ? t(
        'orcaCloudWorkspace.oom.detail',
        'The VM stopped it to stay up. Restart for a clean slate, or use a larger machine for this workload.'
      )
    : t(
        'orcaCloudWorkspace.unresponsive.detail',
        'Restart keeps your files and continues interrupted agents.'
      )
  const Icon = isOom ? MemoryStick : Unplug
  return (
    <div
      role="alert"
      data-cloud-notice={notice.kind}
      className="pointer-events-auto flex w-[22rem] max-w-[calc(100%-1.5rem)] items-start gap-3 rounded-lg border border-amber-500/40 bg-card/95 p-3 text-card-foreground shadow-[0_8px_24px_rgba(0,0,0,0.18)] backdrop-blur motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1"
    >
      <Icon className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="space-y-0.5">
          <div className="text-sm font-medium leading-5">{title}</div>
          <p className="text-xs text-muted-foreground">{detail}</p>
        </div>
        <Button size="xs" onClick={onRestart} disabled={restarting}>
          {restarting ? <Loader2 className="animate-spin" /> : <RotateCw />}
          {restarting
            ? t('orcaCloudWorkspace.restarting', 'Restarting…')
            : t('orcaCloudWorkspace.restart', 'Restart')}
        </Button>
      </div>
      {onDismiss ? (
        <Button
          size="icon-xs"
          variant="ghost"
          className="-mt-1 -mr-1 text-muted-foreground"
          aria-label={t('orcaCloudWorkspace.dismiss', 'Dismiss')}
          onClick={onDismiss}
        >
          <X />
        </Button>
      ) : null}
    </div>
  )
}
