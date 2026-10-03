export type FeedbackImageShrinkStep = {
  scale: number
  contentType: 'image/png' | 'image/jpeg'
}

// Why: screenshots are mostly text, which JPEG smears, so every PNG size is
// tried before the first lossy one. Retina captures stay readable at 0.5.
const FEEDBACK_IMAGE_PNG_SHRINK_STEPS: readonly FeedbackImageShrinkStep[] = [
  { scale: 0.75, contentType: 'image/png' },
  { scale: 0.5, contentType: 'image/png' }
]

const FEEDBACK_IMAGE_JPEG_SHRINK_STEPS: readonly FeedbackImageShrinkStep[] = [
  { scale: 1, contentType: 'image/jpeg' },
  { scale: 0.75, contentType: 'image/jpeg' },
  { scale: 0.5, contentType: 'image/jpeg' },
  { scale: 0.25, contentType: 'image/jpeg' }
]

const FEEDBACK_IMAGE_JPEG_QUALITY = 0.85

/**
 * Why: a PNG of an already-lossy source re-encodes JPEG noise losslessly, so it
 * runs many times larger than the source it has to undercut — a multi-megapixel
 * photo would burn two full-size PNG encodes and their buffers to never fit.
 */
export function feedbackImageShrinkSteps(sourceType: string): readonly FeedbackImageShrinkStep[] {
  return sourceType === 'image/jpeg'
    ? FEEDBACK_IMAGE_JPEG_SHRINK_STEPS
    : [...FEEDBACK_IMAGE_PNG_SHRINK_STEPS, ...FEEDBACK_IMAGE_JPEG_SHRINK_STEPS]
}

/** Returns the first step's encoding that fits, or null when none does. */
export async function shrinkFeedbackImageWithin(
  steps: readonly FeedbackImageShrinkStep[],
  // Encodes the decoded image at one step; null when the browser cannot encode it.
  encode: (step: FeedbackImageShrinkStep) => Promise<Blob | null>,
  maxBytes: number
): Promise<Blob | null> {
  for (const step of steps) {
    const blob = await encode(step)
    if (blob && blob.size <= maxBytes) {
      return blob
    }
  }
  return null
}

async function encodeBitmap(
  bitmap: ImageBitmap,
  step: FeedbackImageShrinkStep
): Promise<Blob | null> {
  const canvas = document.createElement('canvas')
  try {
    canvas.width = Math.max(1, Math.floor(bitmap.width * step.scale))
    canvas.height = Math.max(1, Math.floor(bitmap.height * step.scale))
    const context = canvas.getContext('2d')
    if (!context) {
      return null
    }
    if (step.contentType === 'image/jpeg') {
      // Why: JPEG has no alpha, and transparent pixels would otherwise encode black.
      context.fillStyle = '#fff'
      context.fillRect(0, 0, canvas.width, canvas.height)
    }
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    // Why: toBlob hands the encode back asynchronously; toDataURL would block the dialog on it.
    return await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, step.contentType, FEEDBACK_IMAGE_JPEG_QUALITY)
    )
  } finally {
    // Why: toBlob snapshots the backing store, so once it has answered the step's
    // canvas can go. Holding all six until GC runs risks tripping the renderer's
    // canvas memory budget, which hands back a blank canvas — and a blank
    // screenshot would upload without anything noticing.
    canvas.width = 0
    canvas.height = 0
  }
}

/** Decodes once and re-encodes smaller until it fits; null when nothing fits. */
export async function shrinkFeedbackImage(image: Blob, maxBytes: number): Promise<Blob | null> {
  const bitmap = await createImageBitmap(image)
  try {
    return await shrinkFeedbackImageWithin(
      feedbackImageShrinkSteps(image.type),
      (step) => encodeBitmap(bitmap, step),
      maxBytes
    )
  } finally {
    bitmap.close()
  }
}
