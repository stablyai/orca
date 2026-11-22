import React from 'react'
import { cn } from '@/lib/class-names'
import { overlapCutoutMask } from '@/lib/overlap-cutout-mask'
import type { Bot } from '../../../../shared/bot-types'
import {
  BOT_GROUP_FACE_GAP,
  BOT_GROUP_FACE_SLOT,
  type BotGroupFace
} from '../../../../shared/bots/bot-group-face-layout'
import { BotAvatar, BotAvatarTile } from './BotAvatar'

/** A group's overlapping member circles, laid out by one of the face layouts. */
export function BotGroupFaces({
  faces: layout,
  className,
  slot = BOT_GROUP_FACE_SLOT
}: {
  faces: readonly BotGroupFace<Bot>[]
  /** Sizes the slot the faces fill. */
  className: string
  /** The slot's side in px; the layout is drawn for BOT_GROUP_FACE_SLOT and scaled to it. */
  slot?: number
}): React.JSX.Element {
  const faces = scaleBotGroupFaces(layout, slot / BOT_GROUP_FACE_SLOT)
  return (
    <span className={cn('relative block shrink-0', className)} data-testid="bot-group-faces">
      {faces.map((face, index) => {
        const style = botGroupFaceStyle(face, faces.slice(index + 1))
        return 'member' in face.face ? (
          <BotAvatar
            key={face.key}
            bot={face.face.member}
            className="absolute rounded-full"
            style={style}
          />
        ) : (
          <BotAvatarTile
            key={face.key}
            src={null}
            fallback={`+${face.face.more}`}
            className="absolute rounded-full font-medium text-muted-foreground"
            style={style}
          />
        )
      })}
    </span>
  )
}

function scaleBotGroupFaces(
  faces: readonly BotGroupFace<Bot>[],
  scale: number
): readonly BotGroupFace<Bot>[] {
  if (scale === 1) {
    return faces
  }
  return faces.map((face) => ({
    ...face,
    x: face.x * scale,
    y: face.y * scale,
    size: face.size * scale,
    font: face.font * scale
  }))
}

/** Places a circle and cuts a clear gap where a later one overlaps it, so it matches any background. */
function botGroupFaceStyle(
  face: BotGroupFace<Bot>,
  above: readonly BotGroupFace<Bot>[]
): React.CSSProperties {
  return {
    left: face.x,
    top: face.y,
    width: face.size,
    height: face.size,
    fontSize: face.font,
    ...overlapCutoutMask(face, above, BOT_GROUP_FACE_GAP)
  }
}
