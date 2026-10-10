import React from 'react'
import { ImagePlus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import {
  FEEDBACK_IMAGE_FILE_ACCEPT,
  MAX_FEEDBACK_IMAGE_COUNT,
  MAX_FEEDBACK_IMAGE_TOTAL_BYTES,
  formatFeedbackImageSize,
  type FeedbackImageDraft
} from '@/lib/feedback-image-attachments'

// Why: an image that needs no shrink reads in a few ms, which would only flash the hint.
const PREPARING_HINT_DELAY_MS = 250

type SidebarFeedbackImageAttachmentsProps = {
  images: FeedbackImageDraft[]
  /** Files picked but not yet read; a shrink keeps them pending long enough to show. */
  pendingCount: number
  disabled: boolean
  isDragActive: boolean
  onAddFiles: (files: readonly File[]) => void
  onRemove: (id: string) => void
}

export function SidebarFeedbackImageAttachments({
  images,
  pendingCount,
  disabled,
  isDragActive,
  onAddFiles,
  onRemove
}: SidebarFeedbackImageAttachmentsProps): React.JSX.Element {
  const fileInputRef = React.useRef<HTMLInputElement>(null)
  // Why: the byte budget binds long before the count does for full-screen
  // screenshots, so an affordance that only knows the count invites picks that
  // can only ever be rejected.
  const attachedBytes = images.reduce((total, image) => total + image.bytes, 0)
  const atCapacity =
    images.length >= MAX_FEEDBACK_IMAGE_COUNT || attachedBytes >= MAX_FEEDBACK_IMAGE_TOTAL_BYTES
  const hasPendingReads = pendingCount > 0
  const [showPreparing, setShowPreparing] = React.useState(false)
  React.useEffect(() => {
    if (!hasPendingReads) {
      setShowPreparing(false)
      return
    }
    const timer = window.setTimeout(() => setShowPreparing(true), PREPARING_HINT_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [hasPendingReads])
  const isPreparing = hasPendingReads && showPreparing

  return (
    <div
      className={cn(
        'rounded-md border border-dashed border-border/70 px-3 py-2 transition-colors',
        isDragActive && 'border-ring bg-accent/40'
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          {/* Why: shrinking an oversized screenshot is slow enough that a silent gap
              between the pick and the thumbnail reads as a dropped attachment. */}
          {isPreparing
            ? translate(
                'auto.components.sidebar.SidebarFeedbackImageAttachments.preparing',
                'Preparing attachments…'
              )
            : translate(
                'auto.components.sidebar.SidebarFeedbackImageAttachments.screenshotsHint',
                'Attach up to {{count}} screenshots, {{maxSize}} total',
                {
                  count: MAX_FEEDBACK_IMAGE_COUNT,
                  maxSize: formatFeedbackImageSize(MAX_FEEDBACK_IMAGE_TOTAL_BYTES)
                }
              )}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 shrink-0 text-xs"
          disabled={disabled || atCapacity}
          onClick={() => fileInputRef.current?.click()}
        >
          <ImagePlus className="size-3.5" />
          {translate(
            'auto.components.sidebar.SidebarFeedbackImageAttachments.attachImages',
            'Attach'
          )}
        </Button>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept={FEEDBACK_IMAGE_FILE_ACCEPT}
        multiple
        className="hidden"
        onChange={(event) => {
          onAddFiles(Array.from(event.target.files ?? []))
          // Why: reset so re-picking the same file still fires onChange.
          event.target.value = ''
        }}
      />

      {images.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-2">
          {images.map((image) => (
            <li key={image.id} className="group/attachment relative">
              <img
                src={image.previewUrl}
                alt={image.name}
                className="size-14 rounded border border-border object-cover"
              />
              <Button
                type="button"
                variant="outline"
                size="icon-xs"
                aria-label={translate(
                  'auto.components.sidebar.SidebarFeedbackImageAttachments.removeImage',
                  'Remove {{fileName}}',
                  { fileName: image.name }
                )}
                disabled={disabled}
                onClick={() => onRemove(image.id)}
                className="absolute -right-2 -top-2 rounded-full text-muted-foreground opacity-80 hover:opacity-100 hover:text-foreground focus-visible:opacity-100"
              >
                <X className="size-2.5" />
              </Button>
              <span className="mt-0.5 block text-center text-[10px] leading-none text-muted-foreground">
                {formatFeedbackImageSize(image.bytes)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
