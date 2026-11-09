import { HardDrive, TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'

const GB = 1024 ** 3
const MB = 1024 ** 2

/** "1.4 GB", "32 GB", "480 MB": one decimal only where it changes the reading. */
export function formatDiskBytes(bytes: number): string {
  if (bytes >= GB) {
    const value = bytes / GB
    return `${value >= 10 ? Math.round(value) : Math.floor(value * 10) / 10} GB`
  }
  return `${Math.max(0, Math.floor(bytes / MB))} MB`
}

/** The low-disk strip shown along the bottom of a cloud workspace. */
export function LowDiskBannerView({
  level,
  availableBytes,
  totalBytes,
  onDismiss
}: {
  level: 'warning' | 'critical'
  availableBytes: number
  totalBytes: number
  onDismiss: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const critical = level === 'critical'
  const vars = { free: formatDiskBytes(availableBytes), total: formatDiskBytes(totalBytes) }
  const Icon = critical ? TriangleAlert : HardDrive
  return (
    <div
      // Why alert only when critical: a warning is ambient state; a nearly full disk breaks the next build.
      role={critical ? 'alert' : 'status'}
      data-low-disk-level={level}
      className={cn(
        'flex shrink-0 items-start gap-2.5 border-t px-3 py-2 text-xs',
        critical
          ? 'border-destructive/40 bg-background bg-[linear-gradient(color-mix(in_srgb,var(--destructive)_10%,transparent),color-mix(in_srgb,var(--destructive)_10%,transparent))]'
          : 'border-status-warning-border bg-background bg-[linear-gradient(var(--status-warning-background),var(--status-warning-background))]'
      )}
    >
      <Icon
        className={cn(
          'mt-0.5 size-4 shrink-0',
          critical ? 'text-destructive' : 'text-status-warning'
        )}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1 leading-5">
        <p className="font-medium text-foreground">
          {critical
            ? t(
                'workspace.lowDisk.criticalTitle',
                'Cloud workspace disk is almost full: {{free}} free of {{total}}',
                vars
              )
            : t(
                'workspace.lowDisk.warningTitle',
                'Low disk space on this cloud workspace: {{free}} free of {{total}}',
                vars
              )}
        </p>
        <p className="text-muted-foreground">
          {critical
            ? t(
                'workspace.lowDisk.criticalBody',
                'Builds, installs and git operations may fail soon. Clean build outputs or caches (e.g. rm -rf node_modules/.cache), or remove unused worktrees.'
              )
            : t(
                'workspace.lowDisk.warningBody',
                'Clean build outputs or caches (e.g. rm -rf node_modules/.cache), or remove unused worktrees.'
              )}
        </p>
      </div>
      <Button type="button" variant="ghost" size="xs" className="shrink-0" onClick={onDismiss}>
        {t('workspace.lowDisk.dismiss', 'Dismiss')}
      </Button>
    </div>
  )
}
