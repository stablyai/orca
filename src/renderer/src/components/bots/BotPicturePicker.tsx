import React, { useRef } from 'react'
import { Trans } from 'react-i18next'
import { ChevronLeft, ChevronRight, ImageUp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { i18n } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { isMacUserAgent } from '@/app-shell/platform/user-agent-platform'
import { PICKABLE_BOT_MASCOT_IDS } from '../../../../shared/bot-avatar'
import { BotAvatarTile } from './BotAvatar'
import { BOT_AVATAR_ACCEPT } from './bot-avatar-intake'
import { BOT_MASCOT_URLS } from './bot-mascots'
import { BotPictureIntakeLine, BotPictureVeil, LineAction } from './BotPictureIntakeLine'
import { useBotAvatarIntake } from './use-bot-avatar-intake'

type BotPictureFace = { key: string; src: string | null; fallback: string }

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
function BotPictureCarousel({
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
  const go = (next: number): void => onIndexChange(((next % count) + count) % count)
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
        return (
          <button
            key={face.key}
            type="button"
            tabIndex={-1}
            aria-hidden
            data-position={distance === 0 ? 'current' : distance === 1 ? 'neighbour' : 'hidden'}
            data-dropping={dropping || undefined}
            onClick={() => go(i)}
            style={{
              transform: `translate(calc(-50% + ${x}px), -50%) scale(${distance === 0 ? 1 : NEIGHBOUR_SCALE})`
            }}
            className="absolute top-1/2 left-1/2 rounded-xl transition-[transform,opacity] duration-300 ease-out outline-none motion-reduce:transition-none data-[position=current]:z-20 data-[position=current]:cursor-default data-[position=current]:group-focus-visible:ring-[3px] data-[position=current]:group-focus-visible:ring-ring/50 data-[position=hidden]:pointer-events-none data-[position=hidden]:opacity-0 data-[position=neighbour]:z-10 data-[position=neighbour]:opacity-40 data-[position=neighbour]:data-dropping:opacity-20"
          >
            <BotAvatarTile
              src={face.src}
              fallback={face.fallback}
              className="size-28 rounded-xl text-4xl"
            />
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

/** For the popover's content around a picker: outlined while a picture is dragged over it. */
export const BOT_PICTURE_DROP_OUTLINE =
  'rounded-md in-data-[bot-picture-drop]:ring-[1.5px] in-data-[bot-picture-drop]:ring-foreground/35 in-data-[bot-picture-drop]:ring-inset'

/** Which picture is chosen: a mascot by its place in PICKABLE_BOT_MASCOT_IDS, or the custom one. */
export type BotPictureValue = { kind: 'mascot'; index: number } | { kind: 'custom' }

/** A picture that is not a mascot (an upload, or an older emoji), shown just after mascot `after` (-1: first). */
export type BotPictureCustom = {
  src: string | null
  fallback: string
  after: number
  description: string
}

const CUSTOM_KEY = 'custom'
const MASCOT_FACES: BotPictureFace[] = PICKABLE_BOT_MASCOT_IDS.map((id) => ({
  key: id,
  src: BOT_MASCOT_URLS[id],
  fallback: ''
}))

function pictureFaces(custom: BotPictureCustom | null): BotPictureFace[] {
  if (!custom) {
    return MASCOT_FACES
  }
  const face = { key: CUSTOM_KEY, src: custom.src, fallback: custom.fallback }
  return [...MASCOT_FACES.slice(0, custom.after + 1), face, ...MASCOT_FACES.slice(custom.after + 1)]
}

/** The mascot a value stands on; a custom picture stands on the mascot before it. */
export function pictureMascotIndex(
  value: BotPictureValue,
  custom: BotPictureCustom | null
): number {
  return value.kind === 'mascot' ? value.index : Math.max(0, custom?.after ?? 0)
}

/** A bot's picture: a carousel of the mascots (plus any custom picture); upload, paste or drop your own. */
export function BotPicturePicker({
  value,
  custom,
  onChange,
  onUpload,
  onUndo,
  uploadLink = false
}: {
  value: BotPictureValue
  custom: BotPictureCustom | null
  onChange: (value: BotPictureValue) => void
  /** A square 512 px PNG, base64, and where it goes, as `BotPictureCustom.after`. */
  onUpload: (png: string, after: number) => void
  /** Where a new picture saves at once: puts the previous one back. */
  onUndo?: () => void
  /** The hint as one caption line with an inline Upload (New bot), not the upload button. */
  uploadLink?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const rootRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const faces = pictureFaces(custom)
  const showingCustom = value.kind === 'custom' && custom !== null
  const mascotIndex = pictureMascotIndex(value, custom)
  const faceIndex = showingCustom
    ? custom.after + 1
    : mascotIndex + (custom && mascotIndex > custom.after ? 1 : 0)
  // A new picture replaces the custom one in place, or lands beside the mascot shown.
  const intake = useBotAvatarIntake({
    rootRef,
    onPicture: (png) => onUpload(png, showingCustom ? custom.after : mascotIndex),
    undoable: onUndo !== undefined
  })
  const { line } = intake
  const dropping = line.kind === 'drop'
  return (
    <div
      ref={rootRef}
      data-dropping={(dropping && intake.outlinePicker) || undefined}
      className="relative before:pointer-events-none before:absolute before:-inset-x-2.5 before:-top-2.5 before:-bottom-1.5 before:hidden before:rounded-[14px] before:border-[1.5px] before:border-dashed before:border-foreground/35 data-dropping:before:block"
    >
      <BotPictureCarousel
        faces={faces}
        index={faceIndex}
        dropping={dropping}
        description={
          showingCustom
            ? custom.description
            : t('bots.new.pictureMascot', 'Mascot {{n}} of {{total}}', {
                n: mascotIndex + 1,
                total: PICKABLE_BOT_MASCOT_IDS.length
              })
        }
        onIndexChange={(index) => {
          if (line.kind === 'error') {
            intake.dismiss()
          }
          if (faces[index]?.key === CUSTOM_KEY) {
            onChange({ kind: 'custom' })
          } else {
            onChange({ kind: 'mascot', index: index - (custom && index > custom.after ? 1 : 0) })
          }
        }}
      />
      <BotPictureIntakeLine
        line={line}
        onUndo={() => {
          intake.dismiss()
          onUndo?.()
        }}
      >
        {uploadLink ? (
          <span>
            <Trans
              i18n={i18n}
              defaults={t(
                'bots.new.uploadDropOrPaste',
                '<upload>Upload</upload>, drop, or paste an image'
              )}
              components={{ upload: <LineAction onClick={() => fileRef.current?.click()} /> }}
            />
          </span>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => fileRef.current?.click()}
              >
                <ImageUp />
                {t('bots.new.uploadPasteOrDrop', 'or upload, paste or drop your own')}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={4}>
              {t('bots.new.pasteHint', 'Paste an image with {{shortcut}}', {
                shortcut: isMacUserAgent() ? '⌘V' : 'Ctrl+V'
              })}
            </TooltipContent>
          </Tooltip>
        )}
      </BotPictureIntakeLine>
      <input
        ref={fileRef}
        type="file"
        accept={BOT_AVATAR_ACCEPT}
        className="hidden"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0]
          event.currentTarget.value = ''
          if (file) {
            intake.take(file)
          }
        }}
      />
    </div>
  )
}
