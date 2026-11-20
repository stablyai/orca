// New bot's picture: one tile with a pencil; a click opens the picker in a popover. An image pasted
// or dropped anywhere in the dialog is taken too, into the dialog's one intake, which the popover's
// picker shares: a decode outlives the popover, and the newest picture wins across both.
import React, { useEffect, useRef, useState } from 'react'
import { CircleAlert, Pencil } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { BotAvatarTile } from './BotAvatar'
import { BotPictureVeil, useIntakeErrorMessage } from './BotPictureIntakeLine'
import { BOT_PICTURE_DROP_OUTLINE, BotPicturePicker } from './BotPicturePicker'
import { useBotAvatarIntakeHost, type BotAvatarIntake } from './use-bot-avatar-intake'
import type { NewBotPicture } from './use-new-bot-picture'

/** The unified form dialog's padding (`p-5`). */
const DIALOG_PADDING_PX = 20

export function NewBotPictureButton({
  picture,
  intake
}: {
  picture: NewBotPicture
  /** The dialog's intake, which places a picture with `picture.placeUpload`. */
  intake: BotAvatarIntake
}): React.JSX.Element {
  const t = useTranslate()
  const errorMessage = useIntakeErrorMessage()
  const rootRef = useRef<HTMLDivElement>(null)
  useBotAvatarIntakeHost(rootRef, intake)
  const { line } = intake
  // The popover stays inside the dialog's padding, so a narrow dialog narrows it rather than its edge.
  const [dialog, setDialog] = useState<HTMLElement | null>(null)
  useEffect(() => {
    setDialog(rootRef.current?.closest<HTMLElement>('[role="dialog"]') ?? null)
  }, [])
  return (
    <div ref={rootRef} className="flex items-center gap-3">
      <Popover onOpenChange={(open) => open && line.kind === 'error' && intake.dismiss()}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={t('bots.new.changePicture', 'Change picture')}
            className="group/picture relative size-16 shrink-0 cursor-pointer rounded-[18px] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <BotAvatarTile
              src={picture.src}
              fallback=""
              className="size-16 rounded-[inherit] shadow-[0_0_0_3px_var(--dialog-surface)] transition-[filter] group-hover/picture:brightness-95"
            />
            {line.kind === 'drop' ? (
              <span className="absolute inset-0 overflow-hidden rounded-[inherit] [&>span]:rounded-[inherit] [&>span]:text-[10px]">
                <BotPictureVeil />
              </span>
            ) : null}
            <span
              aria-hidden
              className="absolute -right-1.5 -bottom-1.5 flex size-[22px] items-center justify-center rounded-full border border-border bg-popover text-muted-foreground shadow-[0_0_0_2px_var(--dialog-surface)] transition-colors group-hover/picture:text-foreground group-aria-expanded/picture:text-foreground"
            >
              <Pencil className="size-3" />
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          collisionBoundary={dialog}
          collisionPadding={DIALOG_PADDING_PX}
          className="w-[min(20rem,var(--radix-popover-content-available-width))]"
        >
          {/* The whole popover takes a dropped picture, so all of it is outlined while one is dragged. */}
          <div className={cn(BOT_PICTURE_DROP_OUTLINE, 'pt-3')}>
            <BotPicturePicker
              value={picture.value}
              custom={picture.custom}
              onChange={picture.onChange}
              onUpload={picture.onUpload}
              color={picture.color}
              onColorChange={picture.onColorChange}
              uploadLink
              intake={intake}
            />
          </div>
        </PopoverContent>
      </Popover>
      <div aria-live="polite" className="min-w-0 text-xs">
        {line.kind === 'error' ? (
          <span role="alert" className="inline-flex items-center gap-1.5 text-destructive">
            <CircleAlert className="size-3.5 shrink-0" />
            {errorMessage(line.error)}
          </span>
        ) : null}
      </div>
    </div>
  )
}
