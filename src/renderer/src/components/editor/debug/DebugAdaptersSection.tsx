import { useEffect } from 'react'
import { AlertCircle, CheckCircle2, Download, RefreshCw, X } from 'lucide-react'
import { Button } from '../../ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { useDebugSessionStore } from '@/store/debug/use-debug-session-store'

export function DebugMissingAdapterBanner(): React.JSX.Element | null {
  const t = useTranslate()
  const offer = useDebugSessionStore((s) => s.missingAdapterOffer)
  const installingAdapterId = useDebugSessionStore((s) => s.installingAdapterId)
  const installAdapter = useDebugSessionStore((s) => s.installAdapter)
  const dismiss = useDebugSessionStore((s) => s.dismissMissingAdapterOffer)

  if (!offer) {
    return null
  }

  const busy = installingAdapterId !== null
  const installingThis = installingAdapterId === offer.adapter

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-status-warning-border bg-status-warning-background px-3 py-1.5 text-xs text-status-warning-foreground">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <AlertCircle className="size-3.5 shrink-0 text-status-warning" />
        <span className="truncate font-medium">
          {t('auto.components.editor.debug.missingAdapterPrefix', 'Adapter missing:')}{' '}
          {offer.adapter}
        </span>
        <span className="min-w-0 truncate text-[11px] opacity-85" title={offer.message}>
          {offer.message}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={busy}
          onClick={() => void installAdapter(offer.adapter, offer.config)}
        >
          <Download className="size-3" />
          {installingThis
            ? t('auto.components.editor.debug.installingLabel', 'Installing...')
            : t('auto.components.editor.debug.installAndRetryAction', 'Install & Retry')}
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          title={t('auto.components.editor.debug.closeAction', 'Close')}
          onClick={dismiss}
        >
          <X className="size-3" />
        </Button>
      </div>
    </div>
  )
}

export function DebugAdaptersSection({ cwd }: { cwd?: string | null }): React.JSX.Element {
  const t = useTranslate()
  const adapterStatuses = useDebugSessionStore((s) => s.adapterStatuses)
  const installingAdapterId = useDebugSessionStore((s) => s.installingAdapterId)
  const refreshAdapterStatuses = useDebugSessionStore((s) => s.refreshAdapterStatuses)
  const installAdapter = useDebugSessionStore((s) => s.installAdapter)

  useEffect(() => {
    void refreshAdapterStatuses(cwd)
  }, [cwd, refreshAdapterStatuses])

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between px-1">
        <span className="text-[11px] font-medium text-muted-foreground">
          {t('auto.components.editor.debug.adaptersTitle', 'Debug Adapters')}
        </span>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          title={t('auto.components.editor.debug.refreshTitle', 'Refresh')}
          onClick={() => void refreshAdapterStatuses(cwd)}
        >
          <RefreshCw className="size-3" />
        </Button>
      </div>

      <div className="divide-y divide-border/50 rounded border border-border/70 bg-background/50">
        {adapterStatuses.map((item) => {
          const isMissing = item.status === 'missing'
          const isBusy = installingAdapterId !== null
          const isInstallingThis = installingAdapterId === item.id
          return (
            <div
              key={item.id}
              className="flex items-center justify-between gap-2 px-2 py-1.5 text-xs"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <CheckCircle2
                    className={cn(
                      'size-3 shrink-0',
                      isMissing ? 'text-muted-foreground/50' : 'text-status-success'
                    )}
                  />
                  <span className="truncate font-medium text-foreground">{item.displayName}</span>
                  <span
                    className={cn(
                      'shrink-0 rounded px-1 py-0 text-[10px]',
                      isMissing
                        ? 'bg-muted text-muted-foreground'
                        : 'bg-status-success-background text-status-success'
                    )}
                  >
                    {item.status === 'installed'
                      ? t('auto.components.editor.debug.installedBadge', 'Installed')
                      : item.status === 'onPath'
                        ? t('auto.components.editor.debug.onPathBadge', 'PATH')
                        : t('auto.components.editor.debug.missingBadge', 'Missing')}
                  </span>
                </div>
                <div
                  className="mt-0.5 truncate pl-4 font-mono text-[10px] text-muted-foreground"
                  title={item.path ?? item.installHint}
                >
                  {item.path ?? item.installHint}
                </div>
              </div>

              {item.canInstall && isMissing ? (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={isBusy}
                  onClick={() => void installAdapter(item.id)}
                >
                  <Download className="size-3" />
                  {isInstallingThis
                    ? t('auto.components.editor.debug.installingLabel', 'Installing...')
                    : t('auto.components.editor.debug.installAction', 'Install')}
                </Button>
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}
