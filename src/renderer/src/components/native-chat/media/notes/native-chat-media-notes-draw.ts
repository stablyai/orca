import {
  nativeChatNoteImageSize,
  type NativeChatMediaNote,
  type NativeChatNoteMark
} from './native-chat-media-notes'

// Drawn into the image the agent receives, so these are fixed colors rather than theme tokens.
const MARK_BLUE = '#2f5bd3'
const MARK_FILL = 'rgba(47, 91, 211, 0.16)'
const MARK_EDGE = '#ffffff'

/** Where a mark's number badge sits, in output pixels: a pin's badge above-right of its tip, a box's at its top-left corner. */
export function nativeChatNoteBadgePoint(
  mark: NativeChatNoteMark,
  width: number,
  height: number,
  radius: number
): { x: number; y: number } {
  if (mark.kind === 'box') {
    return { x: mark.x * width, y: mark.y * height }
  }
  return { x: mark.x * width + radius * 0.8, y: mark.y * height - radius * 1.1 }
}

/** Draws `source` with each note's numbered mark into a PNG no larger than the output limit. */
export async function drawNativeChatNotesImage(
  source: ImageBitmapSource,
  sourceSize: { width: number; height: number },
  notes: readonly NativeChatMediaNote[]
): Promise<Blob> {
  const { width, height } = nativeChatNoteImageSize(sourceSize.width, sourceSize.height)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  try {
    const context = canvas.getContext('2d')
    if (!context) {
      throw new Error('Canvas drawing is unavailable.')
    }
    // Decoded straight to the output size: a full-size second decode of a large source would cost
    // up to ~160 MB more at 33 MP (measured), this costs about the output's own size.
    const bitmap = await createImageBitmap(source, {
      resizeWidth: width,
      resizeHeight: height,
      resizeQuality: 'high'
    })
    try {
      context.drawImage(bitmap, 0, 0)
    } finally {
      bitmap.close()
    }
    const unit = Math.max(width, height) / 1000
    const radius = Math.max(9, 14 * unit)
    for (const note of notes) {
      const { mark } = note
      context.lineWidth = Math.max(2, 3 * unit)
      if (mark.kind === 'box') {
        const box = [
          mark.x * width,
          mark.y * height,
          mark.width * width,
          mark.height * height
        ] as const
        context.fillStyle = MARK_FILL
        context.fillRect(...box)
        context.strokeStyle = MARK_BLUE
        context.strokeRect(...box)
      } else {
        const badge = nativeChatNoteBadgePoint(mark, width, height, radius)
        context.strokeStyle = MARK_BLUE
        context.beginPath()
        context.moveTo(mark.x * width, mark.y * height)
        context.lineTo(badge.x, badge.y)
        context.stroke()
      }
      const badge = nativeChatNoteBadgePoint(mark, width, height, radius)
      context.beginPath()
      context.arc(badge.x, badge.y, radius, 0, Math.PI * 2)
      context.fillStyle = MARK_BLUE
      context.fill()
      context.lineWidth = Math.max(2, 2.5 * unit)
      context.strokeStyle = MARK_EDGE
      context.stroke()
      context.fillStyle = MARK_EDGE
      context.font = `600 ${Math.round(radius * 1.15)}px system-ui, sans-serif`
      context.textAlign = 'center'
      context.textBaseline = 'middle'
      context.fillText(String(note.number), badge.x, badge.y + radius * 0.05)
    }
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (blob) =>
          blob ? resolve(blob) : reject(new Error('The marked image could not be encoded.')),
        'image/png'
      )
    )
  } finally {
    // Release the backing store at once rather than waiting for collection.
    canvas.width = 0
    canvas.height = 0
  }
}
