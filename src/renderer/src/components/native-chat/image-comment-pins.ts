import type { PanZoomPoint, PanZoomSize } from '../../../../shared/pan-zoom-view'

export type ImageCommentPin = { id: string; x: number; y: number; comment: string }

export function imageCommentPosition(
  point: PanZoomPoint,
  offset: PanZoomPoint,
  scale: number,
  size: PanZoomSize,
  clamp = false
): PanZoomPoint | null {
  if (!(scale > 0 && size.width > 0 && size.height > 0)) {
    return null
  }
  const x = ((point.x - offset.x) / (size.width * scale)) * 100
  const y = ((point.y - offset.y) / (size.height * scale)) * 100
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    (!clamp && (x < 0 || y < 0 || x > 100 || y > 100))
  ) {
    return null
  }
  return { x: Math.min(100, Math.max(0, x)), y: Math.min(100, Math.max(0, y)) }
}

export function imageCommentBadge(
  point: PanZoomPoint,
  size: PanZoomSize,
  radius = 13
): PanZoomPoint {
  return {
    x: Math.max(Math.min(radius, size.width / 2), Math.min(size.width - radius, point.x + 18)),
    y: Math.max(Math.min(radius, size.height / 2), Math.min(size.height - radius, point.y - 18))
  }
}

export function imageCommentsText(
  title: string,
  size: PanZoomSize,
  pins: readonly ImageCommentPin[]
): string {
  return [
    `Image comments: ${title} (${size.width} × ${size.height} px).`,
    'Positions are percentages of the original image from the top-left (x rightwards, y downwards).',
    ...pins.map(
      (pin, index) =>
        `${index + 1}. [x=${pin.x.toFixed(2)}%, y=${pin.y.toFixed(2)}%] ${pin.comment.trim()}`
    )
  ].join('\n')
}

export function paintImageCommentPins(
  context: CanvasRenderingContext2D,
  size: PanZoomSize,
  pins: readonly ImageCommentPin[],
  ratio: number
): void {
  context.save()
  context.scale(ratio, ratio)
  context.font = 'bold 13px sans-serif'
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  for (const [index, pin] of pins.entries()) {
    const point = { x: (size.width * pin.x) / 100, y: (size.height * pin.y) / 100 }
    const badge = imageCommentBadge(point, size)
    context.beginPath()
    context.moveTo(point.x, point.y)
    context.lineTo(badge.x, badge.y)
    context.strokeStyle = 'white'
    context.lineWidth = 3
    context.stroke()
    context.strokeStyle = 'black'
    context.lineWidth = 1
    context.stroke()
    context.beginPath()
    context.arc(point.x, point.y, 3, 0, Math.PI * 2)
    context.fillStyle = 'black'
    context.fill()
    context.strokeStyle = 'white'
    context.lineWidth = 1
    context.stroke()
    context.beginPath()
    context.arc(badge.x, badge.y, 13, 0, Math.PI * 2)
    context.fillStyle = 'black'
    context.fill()
    context.strokeStyle = 'white'
    context.lineWidth = 2
    context.stroke()
    context.fillStyle = 'white'
    context.fillText(String(index + 1), badge.x, badge.y)
  }
  context.restore()
}
