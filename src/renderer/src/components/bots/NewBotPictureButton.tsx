// New bot's picture: one tile with a pencil; a click opens the picker in a popover. An image pasted
// or dropped anywhere in the dialog is taken while the popover is closed.
import React, { useRef } from 'react'
import { CircleAlert, Pencil } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { BotAvatarTile } from './BotAvatar'
import { BotPictureVeil, useIntakeErrorMessage } from './BotPictureIntakeLine'
import { BOT_PICTURE_DROP_OUTLINE, BotPicturePicker, pictureMascotIndex } from './BotPicturePicker'
import { useBotAvatarIntake } from './use-bot-avatar-intake'
import type { NewBotPicture } from './use-new-bot-picture'

export function NewBotPictureButton({ picture }: { picture: NewBotPicture }): React.JSX.Element {
  const t = useTranslate()
  const errorMessage = useIntakeErrorMessage()
  const rootRef = useRef<HTMLDivElement>(null)
  const showingCustom = picture.value.kind === 'custom' && picture.custom !== null
  // As the picker does: a new picture replaces the custom one in place, or lands beside the mascot.
  const intake = useBotAvatarIntake({
    rootRef,
    onPicture: (png) =>
      picture.onUpload(
        png,
        showingCustom && picture.custom
          ? picture.custom.after
          : pictureMascotIndex(picture.value, picture.custom)
      ),
    undoable: false
  })
  const { line } = intake
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
        <PopoverContent align="start" className="w-80">
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
