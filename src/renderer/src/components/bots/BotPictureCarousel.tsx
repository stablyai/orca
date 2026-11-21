// The picture carousel: the current face large, its wrapped neighbours dimmed beside it.
import React, { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { BotMascotId } from '../../../../shared/bot-avatar'
import { BotAvatarTile } from './BotAvatar'
import type { BotOutfitArt } from './bot-mascot-look'
import { BotMascotBitmapTile } from './BotMascotBitmapTile'
import { BotPictureVeil } from './BotPictureIntakeLine'

const FACE_CLASS =
  'absolute top-1/2 left-1/2 rounded-xl transition-[transform,opacity] duration-300 ease-out outline-none motion-reduce:transition-none data-[position=current]:z-20 data-[position=current]:cursor-default data-[position=current]:group-focus-visible:ring-[3px] data-[position=current]:group-focus-visible:ring-ring/50 data-[position=hidden]:pointer-events-none data-[position=hidden]:opacity-0 data-[position=neighbour]:z-10 data-[position=neighbour]:opacity-40 data-[position=neighbour]:data-dropping:opacity-20'

/** A picture, or a face that draws itself (Generate): interactive when current, a thumbnail beside it. */
export type BotPictureFace =
  | {
      key: string
      src: string | null
      outfit?: BotOutfitArt | null
      fallback: string
      /** A mascot, drawn from its bitmap instead of `src`. */
      mascot?: { id: BotMascotId; color: string | null; face?: string | null }
      render?: undefined
    }
  | { key: string; render: (current: boolean) => React.ReactNode; label: string }

// Neighbours sit this far from the center tile (112 px), drawn at 72 px.
const NEIGHBOUR_OFFSET_PX = 110
const NEIGHBOUR_SCALE = 72 / 112

/** Signed distance from the current face, the short way round the wrapped list. */
function faceOffset(index: number, current: number, count: number): number {
  const ahead = (((index - current) % count) + count) % count
  return ahead > count / 2 ? ahead - count : ahead
}

function ArrowButton({
  label,
  side,
  onClick
}: {
  label: string
  side: 'left' | 'right'
  onClick: () => void
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          data-side={side}
          onClick={onClick}
          className="absolute top-1/2 z-30 -translate-y-1/2 data-[side=left]:left-2 data-[side=right]:right-2"
        >
          {side === 'left' ? <ChevronLeft /> : <ChevronRight />}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

/** The current picture large with its wrapped neighbours dimmed beside it; arrows, clicks or ←/→ move. */
export function BotPictureCarousel({
  faces,
  index,
  description,
  dropping,
  onIndexChange
}: {
  faces: readonly BotPictureFace[]
  index: number
  /** A picture is dragged in: the current face shows the drop target. */
  dropping: boolean
  /** Announced when the picture changes, e.g. "Mascot 3 of 20". */
  description: string
  onIndexChange: (index: number) => void
}): React.JSX.Element {
  const t = useTranslate()
  const count = faces.length
  // Faces slide only for a move the user made, over the list it was made on; a list that changes
  // under them (Generate arriving once its agents are known, a picture taking a slot) lands in place.
  const order = faces.map((face) => face.key).join(' ')
  const [slideOver, setSlideOver] = useState<string | null>(null)
  const sliding = slideOver === order
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (settle.current) {
        clearTimeout(settle.current)
      }
    },
    []
  )
  const go = (next: number): void => {
    setSlideOver(order)
    if (settle.current) {
      clearTimeout(settle.current)
    }
    // A little past the 300 ms slide.
    settle.current = setTimeout(() => setSlideOver(null), 400)
    onIndexChange(((next % count) + count) % count)
  }
  const faceClass = cn(FACE_CLASS, sliding ? 'will-change-[transform,opacity]' : 'transition-none')
  return (
    <div
      role="group"
      aria-roledescription="carousel"
      aria-label={t('bots.new.picture', 'Picture')}
      tabIndex={0}
      className="group relative h-30 outline-none"
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault()
          go(index + (event.key === 'ArrowLeft' ? -1 : 1))
        }
      }}
    >
      <ArrowButton
        label={t('bots.new.previousPicture', 'Previous picture')}
        side="left"
        onClick={() => go(index - 1)}
      />
      {faces.map((face, i) => {
        const offset = faceOffset(i, index, count)
        const distance = Math.abs(offset)
        // Faces past the neighbours wait further out, so they slide in rather than appear.
        const x = Math.sign(offset) * NEIGHBOUR_OFFSET_PX * (distance > 1 ? 1.4 : 1)
        const position = distance === 0 ? 'current' : distance === 1 ? 'neighbour' : 'hidden'
        // Hidden faces wear nothing, so only the three in view read and decode outfit art.
        const shown = position !== 'hidden'
        const style = {
          transform: `translate(calc(-50% + ${x}px), -50%) scale(${distance === 0 ? 1 : NEIGHBOUR_SCALE})`
        }
        // A face that draws itself holds its own controls when current, so it isn't a button then.
        if (face.render && distance === 0) {
          return (
            <div
              key={face.key}
              data-face={face.key}
              data-position={position}
              style={style}
              className={faceClass}
            >
              {face.render(true)}
            </div>
          )
        }
        return (
          <button
            key={face.key}
            data-face={face.key}
            type="button"
            tabIndex={-1}
            aria-hidden
            data-position={position}
            data-dropping={dropping || undefined}
            onClick={() => go(i)}
            style={style}
            className={faceClass}
          >
            {face.render ? (
              face.render(false)
            ) : face.mascot ? (
              <BotMascotBitmapTile
                id={face.mascot.id}
                color={face.mascot.color}
                face={shown ? face.mascot.face : null}
                outfit={shown ? face.outfit : null}
                className="size-28 rounded-xl"
              />
            ) : (
              <BotAvatarTile
                src={face.src}
                outfit={shown ? face.outfit : null}
                fallback={face.fallback}
                className="size-28 rounded-xl text-4xl"
              />
            )}
            {distance === 0 && dropping ? <BotPictureVeil /> : null}
          </button>
        )
      })}
      <ArrowButton
        label={t('bots.new.nextPicture', 'Next picture')}
        side="right"
        onClick={() => go(index + 1)}
      />
      <span className="sr-only" aria-live="polite">
        {description}
      </span>
    </div>
  )
}
