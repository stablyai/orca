import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import type { UpdateStatus } from '../../../shared/types'

function getReleaseUrl(
  status: Extract<UpdateStatus, { state: 'available' | 'downloaded' }>
): string {
  return status.releaseUrl ?? `https://github.com/stablyai/orca/releases/tag/v${status.version}`
}

export default function UpdateReminder(): React.JSX.Element | null {
  const updateStatus = useAppStore((s) => s.updateStatus)
  const dismissedUpdateVersion = useAppStore((s) => s.dismissedUpdateVersion)
  const dismissUpdate = useAppStore((s) => s.dismissUpdate)

  if (updateStatus.state !== 'available' && updateStatus.state !== 'downloaded') {
    return null
  }

  if (updateStatus.state === 'available' && updateStatus.version === dismissedUpdateVersion) {
    return null
  }

  const isDownloaded = updateStatus.state === 'downloaded'
  const label = isDownloaded ? 'Restart to update' : 'Update available'

  return (
    // Persistent bottom-right toast, positioned to sit above the Sonner toaster.
    <div className="fixed bottom-14 right-4 z-50 flex w-72 items-center gap-2 rounded-[var(--radius)] border border-border bg-popover px-3 py-2.5 text-popover-foreground shadow-md">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          {label} <span className="text-muted-foreground">v{updateStatus.version}</span>
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <a
          href={getReleaseUrl(updateStatus)}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-muted-foreground underline-offset-2 hover:underline"
        >
          Notes
        </a>
        <Button
          variant="default"
          size="sm"
          className="h-7 px-2.5 text-xs"
          onClick={() => {
            if (isDownloaded) {
              void window.api.updater.quitAndInstall()
            } else {
              void window.api.updater.download()
            }
          }}
        >
          {isDownloaded ? 'Restart' : 'Install'}
        </Button>
        {!isDownloaded ? (
          <button
            onClick={() => dismissUpdate()}
            aria-label="Dismiss"
            className="ml-0.5 rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        ) : null}
      </div>
    </div>
  )
}
