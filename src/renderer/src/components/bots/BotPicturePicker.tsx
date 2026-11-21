import React, { useRef, useState } from 'react'
import { Trans } from 'react-i18next'
import { ImageUp, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ColorPicker } from '@/components/ui/color-picker'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { i18n } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { isMacUserAgent } from '@/app-shell/platform/user-agent-platform'
import { PICKABLE_BOT_MASCOT_IDS } from '../../../../shared/bot-avatar'
import {
  BOT_AVATAR_COLORS,
  DEFAULT_BOT_AVATAR_COLOR
} from '../../../../shared/bots/bot-avatar-color'
import { BOT_AVATAR_ACCEPT } from './bot-avatar-intake'
import { BotPictureIntakeLine, LineAction } from './BotPictureIntakeLine'
import {
  useBotAvatarIntakeHost,
  useBotAvatarIntakeState,
  type BotAvatarIntake
} from './use-bot-avatar-intake'
import { BotPictureCarousel, type BotPictureFace } from './BotPictureCarousel'
import {
  GenerateField,
  GenerateFaceThumb,
  GenerateFaceTile,
  useGenerateFace,
  type GenerateFace
} from './AvatarGenerateFace'
import { BotPictureRowFold } from './BotPictureRowFold'
import { readAvatarCapability } from './avatar-generation-capability-store'
import {
  CUSTOM_FACE,
  GENERATE_FACE,
  isGeneratedCustom,
  pictureFaceOrder,
  type GenerateSlot,
  type PictureFaceKey
} from './bot-picture-face-order'

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

/** The mascot's tile color: the swatches, then any color. */
function BotPictureColors({
  color,
  onChange
}: {
  color: string | null
  onChange: (color: string | null) => void
}): React.JSX.Element {
  const t = useTranslate()
  const current = color ?? DEFAULT_BOT_AVATAR_COLOR
  const isCustom = !BOT_AVATAR_COLORS.some((swatch) => swatch === current)
  const names: Record<(typeof BOT_AVATAR_COLORS)[number], string> = {
    '#b3dbf4': t('bots.new.colorSky', 'Sky'),
    '#ffffff': t('bots.new.colorWhite', 'White'),
    '#c9b8e8': t('bots.new.colorLavender', 'Lavender'),
    '#f4c4cf': t('bots.new.colorPink', 'Pink'),
    '#f8cfa8': t('bots.new.colorPeach', 'Peach'),
    '#f6e3a1': t('bots.new.colorButter', 'Butter'),
    '#c5dfb5': t('bots.new.colorSage', 'Sage'),
    '#b5e3d8': t('bots.new.colorMint', 'Mint'),
    '#8fa3b8': t('bots.new.colorSlate', 'Slate'),
    '#3a3f4b': t('bots.new.colorGraphite', 'Graphite'),
    '#1f2126': t('bots.new.colorInk', 'Ink')
  }
  return (
    <div
      role="group"
      aria-label={t('bots.new.pictureColor', 'Background color')}
      className="mt-2 flex flex-wrap items-center justify-center gap-1"
    >
      {BOT_AVATAR_COLORS.map((swatch) => (
        <button
          key={swatch}
          type="button"
          aria-label={names[swatch]}
          aria-pressed={swatch === current}
          style={{ backgroundColor: swatch }}
          onClick={() => onChange(swatch === DEFAULT_BOT_AVATAR_COLOR ? null : swatch)}
          className={cn(
            'size-4 cursor-pointer rounded-full border border-black/10 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:border-white/15',
            swatch === current && 'ring-2 ring-foreground ring-offset-2 ring-offset-popover'
          )}
        />
      ))}
      {isCustom ? (
        <span
          aria-hidden
          style={{ backgroundColor: current }}
          className="size-4 rounded-full border border-black/10 ring-2 ring-foreground ring-offset-2 ring-offset-popover dark:border-white/15"
        />
      ) : null}
      <Tooltip>
        <ColorPicker
          value={current}
          onChange={(next) => onChange(next.toLowerCase())}
          label={t('bots.new.pictureColorCustom', 'Custom color')}
          selected={isCustom}
          trigger={
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={t('bots.new.pictureColorCustom', 'Custom color')}
                className="flex size-4 cursor-pointer items-center justify-center rounded-full border border-border bg-muted text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <Plus className="size-3" />
              </button>
            </TooltipTrigger>
          }
        />
        <TooltipContent side="bottom" sideOffset={4}>
          {t('bots.new.pictureColorCustom', 'Custom color')}
        </TooltipContent>
      </Tooltip>
    </div>
  )
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
  uploadLink = false,
  color = null,
  onColorChange,
  intake: sharedIntake,
  generate: sharedFace,
  onIntakeStart
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
  color?: string | null
  /** Shows the color swatches under a mascot. */
  onColorChange?: (color: string | null) => void
  /** An intake that outlives this picker (New bot's picture button), so a decode survives the popover
   *  closing and one order holds across both surfaces; its owner places the picture. */
  intake?: BotAvatarIntake
  /** A Generate face that outlives this picker, so a run goes on with the popover closed; its owner
   *  places the picture made. */
  generate?: GenerateFace
  /** A picture starts being taken in by this picker's own intake; see useBotAvatarIntakeState's onTake. */
  onIntakeStart?: () => () => void
}): React.JSX.Element {
  const t = useTranslate()
  const rootRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  // A click onto Generate puts the cursor in its field; arrow keys leave focus on the carousel.
  const byPointer = useRef(false)
  const showingCustom = value.kind === 'custom' && custom !== null
  const mascotIndex = pictureMascotIndex(value, custom)
  // One step back from the face selected at open reaches Generate; it keeps that place while open.
  const [generateSlot] = useState<GenerateSlot>(() =>
    showingCustom
      ? { before: 'custom', after: custom.after }
      : { before: 'mascot', index: mascotIndex }
  )
  // Generate is current while chosen, even before it holds a picture; selected is applied. Reopened
  // while a run goes on, or after it failed, the picker opens on it.
  const [onGenerate, setOnGenerate] = useState(
    () => sharedFace !== undefined && sharedFace.run.kind !== 'idle'
  )
  const ownIntake = useBotAvatarIntakeState({
    // A new picture replaces the custom one in place, or lands beside the mascot shown.
    onPicture: (png) => {
      setOnGenerate(false)
      onUpload(png, showingCustom ? custom.after : mascotIndex)
    },
    undoable: onUndo !== undefined,
    onTake: onIntakeStart
  })
  const intake = sharedIntake ?? ownIntake
  const outlinePicker = useBotAvatarIntakeHost(rootRef, intake)
  // Read once, at mount: the face list is final from the first paint. A check still unanswered
  // at the very first open (just after launch) means no Generate face for that open only.
  const [withGenerate] = useState(() => (readAvatarCapability()?.length ?? 0) > 0)
  // With Generate, the user's own picture lives in its slot: one tile, never two. An older
  // picture with no image (an emoji) keeps its own face.
  const customInSlot = withGenerate && Boolean(custom?.src)
  const order = pictureFaceOrder(
    custom && !customInSlot ? custom.after : null,
    withGenerate ? generateSlot : null
  )
  const currentKey: PictureFaceKey =
    withGenerate && (onGenerate || (showingCustom && customInSlot))
      ? GENERATE_FACE
      : showingCustom
        ? CUSTOM_FACE
        : (PICKABLE_BOT_MASCOT_IDS[mascotIndex] ?? PICKABLE_BOT_MASCOT_IDS[0])
  const generating = currentKey === GENERATE_FACE
  // The description field mounts the first time Generate is current, not with every open, and stays
  // for the fold back.
  const [seenGenerate, setSeenGenerate] = useState(generating)
  if (generating && !seenGenerate) {
    setSeenGenerate(true)
  }
  // The intake turn a generated picture holds: one taken after it was asked for wins, in any order and
  // even within one render, since the turn is checked when the picture arrives, not from React state.
  const generateTurn = useRef<(() => boolean) | null>(null)
  const ownFace = useGenerateFace(
    (made) => {
      const ownTurn = generateTurn.current?.() ?? true
      // Applied only while Generate is the current face and no picture was taken since it was asked for.
      if (generating && ownTurn) {
        onUpload(made.png, -1)
      }
      return ownTurn
    },
    custom?.src ? { src: custom.src, description: custom.description } : null,
    () => {
      generateTurn.current = intake.claim()
    }
  )
  const face = sharedFace ?? ownFace
  const faces: BotPictureFace[] = order.map((key) =>
    key === GENERATE_FACE
      ? {
          key,
          label: t('bots.avatar.generate.face', 'Generate a picture'),
          render: (current) =>
            current ? <GenerateFaceTile face={face} /> : <GenerateFaceThumb face={face} />
        }
      : key === CUSTOM_FACE
        ? { key, src: custom?.src ?? null, fallback: custom?.fallback ?? '' }
        : { key, src: null, fallback: '', mascot: { id: key, color } }
  )
  // Every picture an intake takes, shared or not and even the same image again, leaves Generate and
  // wins the slot back from a picture made earlier.
  const [seenTaken, setSeenTaken] = useState(intake.taken)
  if (intake.taken !== seenTaken) {
    setSeenTaken(intake.taken)
    setOnGenerate(false)
    face.supersede()
  }
  const { line } = intake
  const dropping = line.kind === 'drop'
  const select = (key: PictureFaceKey | undefined): void => {
    // Choosing a picture is the newest action, so one still being read is dropped. Browsing onto an
    // empty Generate face chooses nothing, and a picture still being read lands as usual.
    const chooses = key !== undefined && (key !== GENERATE_FACE || face.picture !== null)
    if (chooses || line.kind === 'error') {
      intake.dismiss()
    }
    setOnGenerate(key === GENERATE_FACE)
    face.setEditing(false)
    if (key === GENERATE_FACE && !face.picture && byPointer.current) {
      face.focusField(false)
    }
    if (key === GENERATE_FACE) {
      // The slot's picture becomes the bot's picture again; one made while away is applied now.
      if (face.made && !isGeneratedCustom(custom?.src, face.made.png)) {
        onUpload(face.made.png, -1)
      } else if (face.picture) {
        onChange({ kind: 'custom' })
      }
    } else if (key === CUSTOM_FACE) {
      onChange({ kind: 'custom' })
    } else if (key) {
      onChange({ kind: 'mascot', index: PICKABLE_BOT_MASCOT_IDS.indexOf(key) })
    }
  }
  const uploadLine = (
    <BotPictureIntakeLine
      line={line}
      onUndo={() => {
        intake.dismiss()
        face.supersede()
        // An undo isn't an intake turn, so a run still going is stopped here instead.
        if (face.run.kind === 'running') {
          face.cancel()
        }
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
  )
  return (
    <div
      ref={rootRef}
      data-dropping={(dropping && outlinePicker) || undefined}
      onPointerDownCapture={() => {
        byPointer.current = true
      }}
      onKeyDownCapture={() => {
        byPointer.current = false
      }}
      className="relative before:pointer-events-none before:absolute before:-inset-x-2.5 before:-top-2.5 before:-bottom-1.5 before:hidden before:rounded-[14px] before:border-[1.5px] before:border-dashed before:border-foreground/35 data-dropping:before:block"
    >
      <BotPictureCarousel
        faces={faces}
        index={Math.max(0, order.indexOf(currentKey))}
        dropping={dropping}
        description={
          generating
            ? t('bots.avatar.generate.face', 'Generate a picture')
            : showingCustom
              ? custom.description
              : t('bots.new.pictureMascot', 'Mascot {{n}} of {{total}}', {
                  n: mascotIndex + 1,
                  total: PICKABLE_BOT_MASCOT_IDS.length
                })
        }
        onIndexChange={(index) => select(order[index])}
      />
      {/* On Generate the description field takes the swatches' place; the rows cross-fade. */}
      <BotPictureRowFold open={!generating}>
        {onColorChange ? (
          <BotPictureRowFold open={!showingCustom}>
            <BotPictureColors color={color} onChange={onColorChange} />
          </BotPictureRowFold>
        ) : null}
        {uploadLine}
      </BotPictureRowFold>
      {withGenerate ? (
        <BotPictureRowFold open={generating}>
          {seenGenerate ? (
            <>
              <GenerateField face={face} />
              {/* While the slot holds a picture, Upload stays in reach under its description, as
                  do a new picture's Undo and errors. */}
              <BotPictureRowFold open={face.folded || line.kind !== 'hint'}>
                {uploadLine}
              </BotPictureRowFold>
            </>
          ) : null}
        </BotPictureRowFold>
      ) : null}
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
