// New bot's picture: one tile with a pencil, the name beside it; a click opens the picker in a popover. An image pasted
// or dropped anywhere in the dialog is taken too, into the dialog's one intake, which the popover's
// picker shares: a decode outlives the popover, and the newest picture wins across both. The dialog's
// Generate face is shared the same way: a run goes on with the popover closed, a spinner in the badge.
import React, { useEffect, useId, useRef, useState } from 'react'
import { CircleAlert, Pencil } from 'lucide-react'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { BotAvatarTile } from './BotAvatar'
import { BotPictureVeil, useIntakeErrorMessage } from './BotPictureIntakeLine'
import { BOT_PICTURE_DROP_OUTLINE, BotPicturePicker } from './BotPicturePicker'
import { useBotAvatarIntakeHost, type BotAvatarIntake } from './use-bot-avatar-intake'
import type { NewBotPicture } from './use-new-bot-picture'
import type { GenerateFace } from './AvatarGenerateFace'

/** The unified form dialog's padding (`p-5`). */
const DIALOG_PADDING_PX = 20

export function NewBotPictureButton({
  picture,
  intake,
  submitted,
  generate,
  disabled = false,
  children
}: {
  picture: NewBotPicture
  /** The dialog's intake, which places a picture with `picture.placeUpload`. */
  intake: BotAvatarIntake
  submitted: boolean
  /** The dialog's Generate face, which places a picture with `picture.onUpload`. */
  generate?: GenerateFace
  /** While Create runs: the picture it took stays as it is. */
  disabled?: boolean
  /** The name field, on the picture's row and centred on it. */
  children: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const readingId = useId()
  const errorMessage = useIntakeErrorMessage()
  const rootRef = useRef<HTMLDivElement>(null)
  useBotAvatarIntakeHost(rootRef, intake)
  const { line } = intake
  const showReading = submitted && intake.reading
  const [open, setOpen] = useState(false)
  // Create closes the popover for good, so one that fails doesn't bring it back.
  if (disabled && open) {
    setOpen(false)
  }
  const running = generate?.run.kind === 'running'
  // The popover stays inside the dialog's padding sideways, so a narrow dialog narrows it rather than its
  // edge; downward it may pass the dialog, so an open outfit grid shows whole.
  const [dialogWidth, setDialogWidth] = useState<number | null>(null)
  useEffect(() => {
    const dialog = rootRef.current?.closest<HTMLElement>('[role="dialog"]')
    if (!dialog) {
      return
    }
    const observer = new ResizeObserver(() => setDialogWidth(dialog.clientWidth))
    observer.observe(dialog)
    return () => observer.disconnect()
  }, [])
  const widthStyle: React.CSSProperties & Record<'--new-bot-picture-width', string> = {
    '--new-bot-picture-width':
      dialogWidth === null ? '20rem' : `${dialogWidth - 2 * DIALOG_PADDING_PX}px`
  }
  return (
    <div ref={rootRef} className="flex flex-wrap items-center gap-x-3">
      <Popover
        open={open && !disabled}
        onOpenChange={(next) => {
          setOpen(next)
          if (next && line.kind === 'error') {
            intake.dismiss()
          }
        }}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            aria-label={t('bots.new.changePicture', 'Change picture')}
            aria-describedby={showReading ? readingId : undefined}
            className="group/picture relative size-16 shrink-0 cursor-pointer rounded-[18px] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-default"
          >
            <BotAvatarTile
              src={picture.src}
              outfit={picture.outfitArt}
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
              className={cn(
                'absolute -right-1.5 -bottom-1.5 flex size-[22px] items-center justify-center rounded-full border border-border bg-popover text-muted-foreground shadow-[0_0_0_2px_var(--dialog-surface)] transition-colors group-hover/picture:text-foreground group-aria-expanded/picture:text-foreground',
                // The spinner reads at full contrast, as the pencil does on hover.
                running && 'text-foreground'
              )}
            >
              {/* A picture still being made, picker open or closed; it lands on its own. */}
              {running ? <LoadingSpinner className="size-3" /> : <Pencil className="size-3" />}
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          collisionPadding={DIALOG_PADDING_PX}
          style={widthStyle}
          // A window too short for the open picker scrolls the card; any other fits it whole.
          wheelScroll
          className="flex w-[min(20rem,var(--new-bot-picture-width),var(--radix-popover-content-available-width))] flex-col"
        >
          {/* The whole popover takes a dropped picture, so all of it is outlined while one is dragged. */}
          <div
            className={cn(
              BOT_PICTURE_DROP_OUTLINE,
              'scrollbar-sleek min-h-0 overflow-x-hidden overflow-y-auto overscroll-contain pt-3'
            )}
          >
            <BotPicturePicker
              value={picture.value}
              custom={picture.custom}
              onChange={picture.onChange}
              onUpload={picture.onUpload}
              color={picture.color}
              onColorChange={picture.onColorChange}
              outfit={picture.outfit}
              onOutfitChange={picture.onOutfitChange}
              uploadLink
              intake={intake}
              generate={generate}
            />
          </div>
        </PopoverContent>
      </Popover>
      <div className="min-w-0 flex-1">
        {children}
        <div aria-live="polite" className="text-xs">
          {line.kind === 'error' ? (
            <span role="alert" className="mt-1 inline-flex items-center gap-1.5 text-destructive">
              <CircleAlert className="size-3.5 shrink-0" />
              {errorMessage(line.error)}
            </span>
          ) : null}
        </div>
      </div>
      {showReading ? (
        <p id={readingId} role="status" className="mt-1 basis-full text-xs text-muted-foreground">
          {t('bots.new.validation.pictureLoading', 'Picture loading…')}
        </p>
      ) : null}
    </div>
  )
}
