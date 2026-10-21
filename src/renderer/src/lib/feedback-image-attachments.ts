import { translate } from '@/i18n/i18n'
import { createBrowserUuid } from './browser-uuid'
import {
  INVALID_RASTER_IMAGE_PREVIEW_ERROR,
  RASTER_IMAGE_PREVIEW_TOO_LARGE_ERROR,
  assertRasterImagePreviewWithinLimits
} from '../../../shared/raster-image-preview-limits'
import {
  MAX_FEEDBACK_IMAGE_BYTES,
  MAX_FEEDBACK_IMAGE_COUNT,
  MAX_FEEDBACK_IMAGE_TOTAL_BYTES
} from '../../../shared/feedback-image-limits'
import { shrinkFeedbackImage } from './feedback-image-shrink'

export {
  MAX_FEEDBACK_IMAGE_BYTES,
  MAX_FEEDBACK_IMAGE_COUNT,
  MAX_FEEDBACK_IMAGE_TOTAL_BYTES
} from '../../../shared/feedback-image-limits'

export const SUPPORTED_FEEDBACK_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif'
] as const

export const FEEDBACK_IMAGE_FILE_ACCEPT = SUPPORTED_FEEDBACK_IMAGE_TYPES.join(',')
const MAX_FEEDBACK_IMAGE_DETAIL_ERRORS = 4
// Why: an oversized image is read whole before it can be shrunk, so cap the read.
export const MAX_FEEDBACK_IMAGE_SOURCE_BYTES = 32 * 1024 * 1024
// Why: a nearly spent budget is unlikely to fit a full-resolution PNG re-encode.
export const MIN_FEEDBACK_IMAGE_SHRINK_TARGET_BYTES = 64 * 1024
// Why: reserve room for another image instead of filling the budget with one optimization.
export const MAX_FEEDBACK_IMAGE_SHRINK_TARGET_BYTES = MAX_FEEDBACK_IMAGE_TOTAL_BYTES / 2

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

function feedbackImageFitBytes(remainingBytes: number): number {
  return Math.min(MAX_FEEDBACK_IMAGE_BYTES, remainingBytes)
}

function feedbackImageShrinkTargetBytes(fitBytes: number): number {
  return Math.min(MAX_FEEDBACK_IMAGE_SHRINK_TARGET_BYTES, fitBytes)
}

// Why: APNG's acTL chunk precedes its first IDAT; shrinking would keep only frame one.
// Walks chunk headers so metadata ahead of acTL or bytes that spell it are not misread.
function isAnimatedPng(data: Uint8Array): boolean {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  // Each chunk after the 8-byte signature is length, type, payload, CRC.
  for (let offset = 8; offset + 8 <= data.byteLength; offset += 12 + view.getUint32(offset)) {
    const type = String.fromCharCode(...data.subarray(offset + 4, offset + 8))
    if (type === 'acTL') {
      return true
    }
    if (type === 'IDAT') {
      return false
    }
  }
  return false
}

/** Fits as-is, or can be shrunk into its capped share of the space left instead of refused. */
function canAttachWithin(file: File, fitBytes: number): boolean {
  if (file.size <= fitBytes) {
    return true
  }
  // Why: re-encoding flattens an animated GIF or WebP, losing what it was attached to show.
  return (
    feedbackImageShrinkTargetBytes(fitBytes) >= MIN_FEEDBACK_IMAGE_SHRINK_TARGET_BYTES &&
    file.type !== 'image/gif' &&
    file.type !== 'image/webp' &&
    file.size <= MAX_FEEDBACK_IMAGE_SOURCE_BYTES
  )
}

/**
 * Whether a paste should be consumed. Extraction stays broad so unsupported
 * image types still reach the rejection toast, but swallowing the paste when
 * nothing is attachable would also discard any text riding along on the
 * clipboard. Every limit readFeedbackImageFiles checks from a file's type and
 * size is mirrored here. Checks that need its bytes (dimensions, APNG, whether a
 * shrink fits) cannot run synchronously; mixed text pastes require an as-is fit.
 */
export function hasAttachableFeedbackImage(
  files: readonly File[],
  existingCount = 0,
  existingBytes = 0,
  options: { allowShrinking?: boolean } = {}
): boolean {
  const fitBytes = feedbackImageFitBytes(MAX_FEEDBACK_IMAGE_TOTAL_BYTES - existingBytes)
  return (
    existingCount < MAX_FEEDBACK_IMAGE_COUNT &&
    files.some(
      (file) =>
        isSupportedType(file.type) &&
        file.size > 0 &&
        (file.size <= fitBytes ||
          (options.allowShrinking !== false && canAttachWithin(file, fitBytes)))
    )
  )
}

/** Upper bound independent of earlier files shrinking, failing, or freeing slots. */
export function maxFeedbackImageBatchBytes(
  files: readonly File[],
  existingCount: number,
  existingBytes: number
): number {
  if (existingCount >= MAX_FEEDBACK_IMAGE_COUNT) {
    return 0
  }
  const remainingBytes = Math.max(0, MAX_FEEDBACK_IMAGE_TOTAL_BYTES - existingBytes)
  const fitBytes = feedbackImageFitBytes(remainingBytes)
  let batchBytes = 0
  for (const file of files) {
    if (!isSupportedType(file.type) || file.size === 0 || !canAttachWithin(file, fitBytes)) {
      continue
    }
    const fileBytes = file.size <= fitBytes ? file.size : feedbackImageShrinkTargetBytes(fitBytes)
    batchBytes += fileBytes
    if (batchBytes >= remainingBytes) {
      return remainingBytes
    }
  }
  return batchBytes
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
 * Converts picked/pasted/dropped files into drafts, optimizing full-resolution PNG for any that would not
 * fit. Rejections and compressions come back as messages, because a silently
 * dropped or degraded attachment is the exact failure this feature exists to fix.
 */
export async function readFeedbackImageFiles(
  files: readonly File[],
  existingCount: number,
  existingBytes = 0
): Promise<{ images: FeedbackImageDraft[]; errors: string[]; notices: string[] }> {
  const images: FeedbackImageDraft[] = []
  const errors: string[] = []
  const notices: string[] = []
  let remaining = MAX_FEEDBACK_IMAGE_COUNT - existingCount
  let remainingBytes = MAX_FEEDBACK_IMAGE_TOTAL_BYTES - existingBytes
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
      // Why: "larger than" holds only for a file the whole budget could not take;
      // otherwise it was the space the other attachments use that refused it.
      const addSizeError = (fitsWholeBudget: boolean): void =>
        addError(() =>
          fitsWholeBudget
            ? translate(
                'auto.lib.feedback.image.attachments.totalTooLarge',
                '{{fileName}} would bring the attachments over {{maxSize}} in total.',
                { fileName, maxSize: formatFeedbackImageSize(MAX_FEEDBACK_IMAGE_TOTAL_BYTES) }
              )
            : translate(
                'auto.lib.feedback.image.attachments.tooLarge',
                '{{fileName}} is larger than {{maxSize}}.',
                { fileName, maxSize: formatFeedbackImageSize(MAX_FEEDBACK_IMAGE_BYTES) }
              )
        )
      const addInvalidImageError = (): void =>
        addError(() =>
          translate(
            'auto.lib.feedback.image.attachments.invalidImage',
            '{{fileName}} is not a valid supported image.',
            { fileName }
          )
        )
      const fitBytes = feedbackImageFitBytes(remainingBytes)
      if (!canAttachWithin(file, fitBytes)) {
        addSizeError(canAttachWithin(file, MAX_FEEDBACK_IMAGE_BYTES))
        continue
      }
      let data = new Uint8Array(await file.arrayBuffer())
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
          addInvalidImageError()
          continue
        }
        throw error
      }
      let image: Blob = file
      if (file.size > fitBytes) {
        let shrunk: Blob | null = null
        const animated = file.type === 'image/png' && isAnimatedPng(data)
        const targetBytes = feedbackImageShrinkTargetBytes(fitBytes)
        if (!animated) {
          try {
            // Why: runs after the dimension check above, which bounds the decode.
            shrunk = await shrinkFeedbackImage(file, targetBytes)
          } catch {
            // Why: its header passed the check above, but the browser could not decode it.
            addInvalidImageError()
            continue
          }
        }
        if (!shrunk) {
          // Why: with the target at its cap, an empty budget would have refused it too.
          addSizeError(
            file.size <= MAX_FEEDBACK_IMAGE_BYTES ||
              (!animated && targetBytes < MAX_FEEDBACK_IMAGE_SHRINK_TARGET_BYTES)
          )
          continue
        }
        image = shrunk
        data = new Uint8Array(await shrunk.arrayBuffer())
        notices.push(
          translate(
            'auto.lib.feedback.image.attachments.compressed',
            '{{fileName}} was compressed from {{originalSize}} to {{size}} to fit the attachment limit.',
            {
              fileName,
              originalSize: formatFeedbackImageSize(file.size),
              size: formatFeedbackImageSize(shrunk.size)
            }
          )
        )
      }
      remaining -= 1
      remainingBytes -= image.size
      images.push({
        // Why: crypto.randomUUID is undefined in non-secure browser contexts (LAN
        // web client over plain HTTP); createBrowserUuid falls back safely.
        id: `${file.name}-${file.size}-${createBrowserUuid()}`,
        name: fileName,
        contentType: image.type,
        bytes: image.size,
        data,
        previewUrl: URL.createObjectURL(image)
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

  return { images, errors, notices }
}

export function extractImageFilesFromDataTransfer(data: DataTransfer | null): File[] {
  if (!data) {
    return []
  }
  return Array.from(data.files).filter((file) => file.type.startsWith('image/'))
}
