import { getSmoothStepPath, Position } from '@xyflow/react'
import type { CanvasNode } from './agent-canvas-document'

type CardBounds = Pick<CanvasNode, 'position' | 'width' | 'height'>

export function canvasConnectionPath(source: CardBounds, target: CardBounds, reciprocal: boolean) {
  const ports = canvasConnectionGeometry(source, target)
  const sourceBottom = source.position.y + source.height
  const targetBottom = target.position.y + target.height
  const preferredOffset = reciprocal ? 48 : 32
  const offset =
    ports.targetX > ports.sourceX
      ? Math.min(preferredOffset, (ports.targetX - ports.sourceX) / 3)
      : preferredOffset
  const centerY =
    ports.targetX - ports.sourceX < offset * 2
      ? sourceBottom + 48 <= target.position.y
        ? (sourceBottom + target.position.y) / 2
        : targetBottom + 48 <= source.position.y
          ? (targetBottom + source.position.y) / 2
          : Math.min(source.position.y, target.position.y) - offset
      : undefined
  const [path, x, y] = getSmoothStepPath({
    ...ports,
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    borderRadius: 24,
    offset,
    centerY
  })
  return { path, x, y }
}

export function canvasConnectionGeometry(source: CardBounds, target: CardBounds) {
  return {
    sourceX: source.position.x + source.width,
    sourceY: source.position.y + source.height / 2,
    targetX: target.position.x,
    targetY: target.position.y + target.height / 2
  }
}
