async function encodeBitmap(bitmap: ImageBitmap): Promise<Blob | null> {
  const canvas = document.createElement('canvas')
  try {
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d')
    if (!context) {
      return null
    }
    context.drawImage(bitmap, 0, 0)
    // Why: automatic optimization must preserve screenshot resolution and avoid JPEG loss.
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  } finally {
    // Why: retain the backing only until toBlob answers, avoiding accumulated canvas memory.
    canvas.width = 0
    canvas.height = 0
  }
}

/** Re-encodes at full resolution without JPEG loss; null when it cannot fit. */
export async function shrinkFeedbackImage(image: Blob, maxBytes: number): Promise<Blob | null> {
  const bitmap = await createImageBitmap(image)
  try {
    const encoded = await encodeBitmap(bitmap)
    return encoded && encoded.size <= maxBytes ? encoded : null
  } finally {
    bitmap.close()
  }
}
