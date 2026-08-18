import { CircleCheck, Download, ExternalLink, FolderOpen, OctagonX, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import {
  formatBrowserDownloadProgress,
  type BrowserDownloadState
} from './browser-download-progress'

export function BrowserPageDownloadList({
  visibleDownloads,
  onOpenDownloadedFile,
  onShowDownloadedFile,
  onDismissDownload
}: {
  visibleDownloads: BrowserDownloadState[]
  onOpenDownloadedFile: (download: BrowserDownloadState) => void
  onShowDownloadedFile: (download: BrowserDownloadState) => void
  onDismissDownload: (downloadId: string) => void
}): React.JSX.Element | null {
  if (visibleDownloads.length === 0) {
    return null
  }

  return (
    <div className="border-b border-border/60 bg-background px-3 py-1.5">
      <div className="scrollbar-sleek flex max-h-36 flex-col gap-1 overflow-y-auto">
        {visibleDownloads.map((download) => {
          const progressLabel = formatBrowserDownloadProgress(download)
          const statusLabel =
            download.status === 'downloading'
              ? download.progressState === 'interrupted'
                ? translate(
                    'auto.components.browser.pane.BrowserPane.39c04fed61',
                    'Downloading paused'
                  )
                : (progressLabel ??
                  translate('auto.components.browser.pane.BrowserPane.759f32af29', 'Downloading'))
              : download.status === 'completed'
                ? translate('auto.components.browser.pane.BrowserPane.5c3d530a68', 'Downloaded')
                : download.status === 'canceled'
                  ? translate('auto.components.browser.pane.BrowserPane.4bb7424d6b', 'Canceled')
                  : (download.error ??
                    translate(
                      'auto.components.browser.pane.BrowserPane.6e776f9ef9',
                      'Download failed'
                    ))
          return (
            <div
              key={download.downloadId}
              className="flex min-h-8 items-center gap-2 text-xs text-foreground"
            >
              {download.status === 'completed' ? (
                <CircleCheck className="size-3.5 shrink-0 text-muted-foreground" />
              ) : download.status === 'failed' ? (
                <OctagonX className="size-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <Download className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{download.filename}</div>
                <div className="truncate text-muted-foreground">
                  {download.status === 'downloading'
                    ? translate(
                        'auto.components.browser.pane.BrowserPane.4300f38145',
                        'Downloading from {{value0}}{{value1}}',
                        {
                          value0: download.origin,
                          value1: statusLabel ? ` • ${statusLabel}` : ''
                        }
                      )
                    : statusLabel}
                </div>
              </div>
              {download.status === 'downloading' ? (
                <Button
                  size="xs"
                  variant="ghost"
                  className="h-6 shrink-0"
                  onClick={() => {
                    void window.api.browser.cancelDownload({
                      downloadId: download.downloadId
                    })
                  }}
                >
                  {translate('auto.components.browser.pane.BrowserPane.fa6ea61de3', 'Cancel')}
                </Button>
              ) : download.status === 'completed' ? (
                <>
                  <Button
                    size="xs"
                    variant="outline"
                    className="h-6 shrink-0 gap-1"
                    onClick={() => {
                      void onOpenDownloadedFile(download)
                    }}
                  >
                    <ExternalLink className="size-3" />
                    {translate('auto.components.browser.pane.BrowserPane.756bfc25c9', 'Open')}
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    className="h-6 shrink-0 gap-1"
                    onClick={() => {
                      void onShowDownloadedFile(download)
                    }}
                  >
                    <FolderOpen className="size-3" />
                    {translate('auto.components.browser.pane.BrowserPane.09a9489aa5', 'Show')}
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="h-6 w-6 shrink-0"
                    onClick={() => onDismissDownload(download.downloadId)}
                    aria-label={translate(
                      'auto.components.browser.pane.BrowserPane.2fdca7df09',
                      'Dismiss'
                    )}
                  >
                    <X className="size-3.5" />
                  </Button>
                </>
              ) : (
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="h-6 w-6 shrink-0"
                  onClick={() => onDismissDownload(download.downloadId)}
                  aria-label={translate(
                    'auto.components.browser.pane.BrowserPane.2fdca7df09',
                    'Dismiss'
                  )}
                >
                  <X className="size-3.5" />
                </Button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
