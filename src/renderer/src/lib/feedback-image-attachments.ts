import { translate } from '@/i18n/i18n'
import { createBrowserUuid } from './browser-uuid'
import {
  INVALID_RASTER_IMAGE_PREVIEW_ERROR,
  RASTER_IMAGE_PREVIEW_TOO_LARGE_ERROR,
  assertRasterImagePreviewWithinLimits
} from '../../../shared/raster-image-preview-limits'

export const MAX_FEEDBACK_IMAGE_COUNT = 4
export const MAX_FEEDBACK_IMAGE_BYTES = 8 * 1024 * 1024
export const SUPPORTED_FEEDBACK_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif'
] as const

export const FEEDBACK_IMAGE_FILE_ACCEPT = SUPPORTED_FEEDBACK_IMAGE_TYPES.join(',')
const MAX_FEEDBACK_IMAGE_DETAIL_ERRORS = 4

export type FeedbackImageDraft = {
  id: string
  name: string
  contentType: string
  bytes: number
  data: Uint8Array
  /** Object URL for the thumbnail; revoke with releaseFeedbackImageDraft. */
  previewUrl: string
}

function isSupportedType(contentType: string): boolean {
  return (SUPPORTED_FEEDBACK_IMAGE_TYPES as readonly string[]).includes(contentType)
}

/**
 * Whether a paste should be consumed. Extraction stays broad so unsupported
 * image types still reach the rejection toast, but swallowing the paste when
 * nothing is attachable would also discard any text riding along on the
 * clipboard.
 */
export function hasAttachableFeedbackImage(files: readonly File[], existingCount = 0): boolean {
  return (
    existingCount < MAX_FEEDBACK_IMAGE_COUNT &&
    files.some(
      (file) => isSupportedType(file.type) && file.size > 0 && file.size <= MAX_FEEDBACK_IMAGE_BYTES
    )
  )
}

export function releaseFeedbackImageDraft(draft: FeedbackImageDraft): void {
  URL.revokeObjectURL(draft.previewUrl)
}

export function formatFeedbackImageSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function feedbackImageDisplayName(file: File): string {
  return (
    file.name || translate('auto.lib.feedback.image.attachments.fallbackName', 'Image attachment')
  )
}

/**
 * Converts picked/pasted/dropped files into drafts. Rejections come back as
 * messages rather than being skipped, because silently dropping an attachment
 * is the exact failure this feature exists to fix.
 */
export async function readFeedbackImageFiles(
  files: readonly File[],
  existingCount: number
): Promise<{ images: FeedbackImageDraft[]; errors: string[] }> {
  const images: FeedbackImageDraft[] = []
  const errors: string[] = []
  let remaining = MAX_FEEDBACK_IMAGE_COUNT - existingCount
  let omittedErrorCount = 0
  const addError = (createMessage: () => string): void => {
    if (errors.length < MAX_FEEDBACK_IMAGE_DETAIL_ERRORS) {
      errors.push(createMessage())
    } else {
      omittedErrorCount += 1
    }
  }

  try {
    for (const file of files) {
      const fileName = feedbackImageDisplayName(file)
      if (!isSupportedType(file.type)) {
        addError(() =>
          translate(
            'auto.lib.feedback.image.attachments.unsupportedType',
            '{{fileName}} is not a supported image type.',
            { fileName }
          )
        )
        continue
      }
      if (file.size === 0) {
        addError(() =>
          translate('auto.lib.feedback.image.attachments.empty', '{{fileName}} is empty.', {
            fileName
          })
        )
        continue
      }
      if (file.size > MAX_FEEDBACK_IMAGE_BYTES) {
        addError(() =>
          translate(
            'auto.lib.feedback.image.attachments.tooLarge',
            '{{fileName}} is larger than {{maxSize}}.',
            {
              fileName,
              maxSize: formatFeedbackImageSize(MAX_FEEDBACK_IMAGE_BYTES)
            }
          )
        )
        continue
      }
      if (remaining <= 0) {
        addError(() =>
          translate(
            'auto.lib.feedback.image.attachments.tooMany',
            'You can attach up to {{maxCount}} images.',
            { maxCount: MAX_FEEDBACK_IMAGE_COUNT }
          )
        )
        break
      }
      const data = new Uint8Array(await file.arrayBuffer())
      try {
        assertRasterImagePreviewWithinLimits(data, file.type)
      } catch (error) {
        if (error instanceof Error && error.message === RASTER_IMAGE_PREVIEW_TOO_LARGE_ERROR) {
          addError(() =>
            translate(
              'auto.lib.feedback.image.attachments.dimensionsTooLarge',
              '{{fileName}} has dimensions that are too large to preview safely.',
              { fileName }
            )
          )
          continue
        }
        if (error instanceof Error && error.message === INVALID_RASTER_IMAGE_PREVIEW_ERROR) {
          addError(() =>
            translate(
              'auto.lib.feedback.image.attachments.invalidImage',
              '{{fileName}} is not a valid supported image.',
              { fileName }
            )
          )
          continue
        }
        throw error
      }
      remaining -= 1
      images.push({
        // Why: crypto.randomUUID is undefined in non-secure browser contexts (LAN
        // web client over plain HTTP); createBrowserUuid falls back safely.
        id: `${file.name}-${file.size}-${createBrowserUuid()}`,
        name: fileName,
        contentType: file.type,
        bytes: file.size,
        data,
        previewUrl: URL.createObjectURL(file)
      })
    }
  } catch (error) {
    // Why: a rejected read never returns these drafts, and an un-revoked object
    // URL pins its blob for the life of the renderer.
    images.forEach(releaseFeedbackImageDraft)
    throw error
  }

  if (omittedErrorCount > 0) {
    errors.push(
      translate(
        'auto.lib.feedback.image.attachments.additionalErrors',
        '{{count}} additional images could not be attached.',
        { count: omittedErrorCount }
      )
    )
  }

  return { images, errors }
}

export function extractImageFilesFromDataTransfer(data: DataTransfer | null): File[] {
  if (!data) {
    return []
  }
  return Array.from(data.files).filter((file) => file.type.startsWith('image/'))
}
