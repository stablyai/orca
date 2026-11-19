import { useRef, useState } from 'react'
import { Image as ImageIcon, Loader2 } from 'lucide-react'
import {
  isRepoIconPickFailure,
  type RepoIconPickPendingResult,
  type RepoIconPreview,
  type RepoIconPreviewResult
} from '../../../../../../shared/repository/appearance/repo-icon-pick-result'
import { MAX_REPO_ICON_UPLOAD_BYTES } from '../../../../../../shared/repository/appearance/repo-icon'
import { formatBytes } from '../../../../../../shared/text/format-bytes'
import { Button } from '../../../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../../../ui/dialog'
import { RepoIconGlyph } from '../../../repo/repo-icon'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useTranslate } from '@/i18n/use-translate'
import { repoIconPickFailureText } from './repo-icon-pick-failure-text'

type RepositoryIconImageDialogProps = {
  pending: RepoIconPickPendingResult | null
  onUse: (dataUrl: string, fileName: string) => void
  onCancel: () => void
  onReselect: () => void
}

// Module level: React Compiler can't lower try/finally inside a component.
async function runRepoIconPreview(
  token: string,
  onResult: (result: RepoIconPreviewResult) => void,
  onError: (error: unknown) => void,
  onSettled: () => void
): Promise<void> {
  try {
    onResult(await window.api.shell.previewRepoIconImage(token))
  } catch (error) {
    onError(error)
  } finally {
    onSettled()
  }
}

export function RepositoryIconImageDialog({
  pending,
  onUse,
  onCancel,
  onReselect
}: RepositoryIconImageDialogProps): React.JSX.Element {
  const t = useTranslate()
  const mountedRef = useMountedRef()
  const requestRef = useRef(0)
  const [preview, setPreview] = useState<RepoIconPreview | null>(null)
  const [processing, setProcessing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleProcess = async (): Promise<void> => {
    if (!pending || processing) {
      return
    }
    const request = requestRef.current + 1
    requestRef.current = request
    const isCurrent = (): boolean => mountedRef.current && request === requestRef.current
    setProcessing(true)
    setError(null)
    await runRepoIconPreview(
      pending.token,
      (result) => {
        if (!isCurrent() || !result) {
          return
        }
        if (isRepoIconPickFailure(result)) {
          setError(repoIconPickFailureText(result))
          return
        }
        setPreview(result)
      },
      (error) => {
        if (!isCurrent()) {
          return
        }
        setError(
          error instanceof Error
            ? error.message
            : t(
                'auto.components.settings.RepositoryIconPicker.868c5c9b56',
                'Failed to import repo icon'
              )
        )
      },
      () => {
        if (isCurrent()) {
          setProcessing(false)
        }
      }
    )
  }

  const oversized = pending !== null && pending.originalBytes > MAX_REPO_ICON_UPLOAD_BYTES
  const actionLabel = oversized
    ? t('settings.repository.iconPreview.compressAction', 'Compress and preview')
    : t('settings.repository.iconPreview.convertAction', 'Convert and preview')
  const busyLabel = oversized
    ? t('settings.repository.iconPreview.compressing', 'Compressing…')
    : t('settings.repository.iconPreview.converting', 'Converting…')

  const footer = (
    <DialogFooter className="sm:justify-between">
      <Button type="button" variant="ghost" onClick={onCancel}>
        {t('settings.repository.iconPreview.cancel', 'Cancel')}
      </Button>
      <div className="flex gap-2">
        <Button type="button" variant="outline" disabled={processing} onClick={onReselect}>
          {t('settings.repository.iconPreview.reselect', 'Reselect')}
        </Button>
        {preview ? (
          <Button
            type="button"
            autoFocus
            onClick={() => pending && onUse(preview.dataUrl, pending.fileName)}
          >
            {t('settings.repository.iconPreview.use', 'Use this icon')}
          </Button>
        ) : (
          <Button type="button" disabled={processing} onClick={() => void handleProcess()}>
            {processing ? <Loader2 className="size-4 animate-spin" /> : null}
            {processing ? busyLabel : actionLabel}
          </Button>
        )}
      </div>
    </DialogFooter>
  )

  return (
    <Dialog open={pending !== null} onOpenChange={(open) => !open && onCancel()}>
      {pending ? (
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {preview
                ? t('settings.repository.iconPreview.previewTitle', 'Preview project icon')
                : t('settings.repository.iconPreview.prepareTitle', 'Prepare project icon')}
            </DialogTitle>
            <DialogDescription>{pending.fileName}</DialogDescription>
          </DialogHeader>

          {preview ? (
            <div className="flex items-start gap-4">
              <figure className="space-y-1.5">
                <div className="flex size-24 items-center justify-center rounded-lg border border-border/70 bg-muted/30 p-2">
                  <img
                    src={preview.dataUrl}
                    alt=""
                    draggable={false}
                    className="max-h-full max-w-full object-contain"
                  />
                </div>
                <figcaption className="text-2xs text-muted-foreground">
                  {t('settings.repository.iconPreview.largePreview', 'Large preview')}
                </figcaption>
              </figure>
              <div className="space-y-2">
                <figure className="space-y-1.5">
                  <div className="flex size-4 items-center justify-center rounded-[4px] text-muted-foreground">
                    <RepoIconGlyph
                      repoIcon={{ type: 'image', src: preview.dataUrl, source: 'upload' }}
                      className="size-4"
                      iconClassName="size-3.5"
                    />
                  </div>
                  <figcaption className="text-2xs text-muted-foreground">
                    {t('settings.repository.iconPreview.sidebarPreview', 'Sidebar size')}
                  </figcaption>
                </figure>
                <div className="space-y-0.5 text-xs text-muted-foreground">
                  <p>
                    {t('settings.repository.iconPreview.originalSize', 'Original: {{size}}', {
                      size: formatBytes(pending.originalBytes)
                    })}
                  </p>
                  <p>
                    {t('settings.repository.iconPreview.resultSize', 'Result: {{size}}', {
                      size: formatBytes(preview.bytes)
                    })}
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-3 rounded-md border border-border/70 bg-muted/30 p-3">
              <ImageIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="space-y-1 text-xs text-muted-foreground">
                <p className="text-sm font-medium text-foreground">
                  {t('settings.repository.iconPreview.originalSize', 'Original: {{size}}', {
                    size: formatBytes(pending.originalBytes)
                  })}
                </p>
                <p>
                  {oversized
                    ? pending.originalMimeType === 'image/jpeg'
                      ? t(
                          'settings.repository.iconPreview.compressJpegDescription',
                          'This JPEG is larger than {{limit}}. Compress it to preview a smaller PNG.',
                          { limit: formatBytes(MAX_REPO_ICON_UPLOAD_BYTES) }
                        )
                      : t(
                          'settings.repository.iconPreview.compressDescription',
                          'This PNG is larger than {{limit}}. Compress it to preview a smaller copy.',
                          { limit: formatBytes(MAX_REPO_ICON_UPLOAD_BYTES) }
                        )
                    : t(
                        'settings.repository.iconPreview.convertDescription',
                        'JPEG images are converted to PNG before they can be used.'
                      )}
                </p>
              </div>
            </div>
          )}

          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}

          {footer}
        </DialogContent>
      ) : null}
    </Dialog>
  )
}
