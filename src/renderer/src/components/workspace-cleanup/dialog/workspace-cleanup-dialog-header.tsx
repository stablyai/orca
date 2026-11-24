import React from 'react'
import { RefreshCcw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'

export function WorkspaceCleanupDialogHeader({
  title,
  loading,
  checking = false,
  updatesAvailable = false,
  onRefresh,
  closeLabel,
  onClose
}: {
  title: React.ReactNode
  loading?: boolean
  /** Git answers are still arriving; the icon spins but a refresh stays available. */
  checking?: boolean
  /** Newer results are waiting; a dot marks the refresh button. */
  updatesAvailable?: boolean
  /** Omitted on steps that have nothing to refresh. */
  onRefresh?: () => void
  closeLabel?: string
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const refreshLabel =
    checking && !loading
      ? t('components.workspace.cleanup.review.checking', 'Checking for changes')
      : updatesAvailable
        ? t('components.workspace.cleanup.review.updatesAvailable', 'Updates available. Refresh')
        : t('components.workspace.cleanup.review.refresh', 'Refresh')
  return (
    <div className="border-b border-border px-4 py-3">
      <DialogHeader>
        <div className="flex items-center justify-between gap-4">
          <DialogTitle size="compact" className="min-w-0">
            {title}
          </DialogTitle>
          <div className="flex shrink-0 items-center gap-1">
            {onRefresh ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="relative"
                    aria-label={refreshLabel}
                    onClick={onRefresh}
                    disabled={loading}
                  >
                    <RefreshCcw
                      className={cn(
                        'size-3.5',
                        (loading || checking) && 'animate-spin motion-reduce:animate-none'
                      )}
                    />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={4}>
                  {refreshLabel}
                </TooltipContent>
              </Tooltip>
            ) : null}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={
                closeLabel ??
                t('auto.components.workspace.cleanup.WorkspaceCleanupDialog.191f0bc98e', 'Close')
              }
              onClick={onClose}
            >
              <X className="size-4" />
            </Button>
          </div>
        </div>
      </DialogHeader>
    </div>
  )
}
