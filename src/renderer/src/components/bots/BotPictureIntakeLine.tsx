// The one line under the picture carousel: the upload hint, or the intake's result or error.
import React from 'react'
import { ArrowDownToLine, Check, CircleAlert } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { BotAvatarIntakeError } from './bot-avatar-intake'
import type { BotAvatarIntakeLine } from './use-bot-avatar-intake'

/** An inline underlined action in a caption line, such as Undo, Upload or Change. */
export function LineAction({
  className,
  ...props
}: React.ComponentProps<'button'>): React.JSX.Element {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        'rounded-sm underline decoration-current/40 underline-offset-2 outline-none hover:decoration-current focus-visible:ring-[3px] focus-visible:ring-ring/50',
        className
      )}
    />
  )
}

export function useIntakeErrorMessage(): (error: BotAvatarIntakeError) => string {
  const t = useTranslate()
  return (error) => {
    switch (error) {
      case 'too_big':
        return t('bots.avatar.intake.tooBig', 'That image is over 10 MB.')
      case 'type':
        return t('bots.avatar.intake.type', "Orca can't read that image. Try PNG or JPEG.")
      case 'too_small':
        return t('bots.avatar.intake.tooSmall', 'Too small. Use an image at least 128 px.')
    }
  }
}

/** `children` is the upload button, shown with the hint. */
export function BotPictureIntakeLine({
  line,
  onUndo,
  children
}: {
  line: BotAvatarIntakeLine
  onUndo: () => void
  children: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const errorMessage = useIntakeErrorMessage()
  return (
    <div
      aria-live="polite"
      className="mt-0.5 flex h-7 items-center justify-center gap-1.5 text-xs whitespace-nowrap text-muted-foreground"
    >
      {line.kind === 'hint' ? children : null}
      {line.kind === 'drop' ? t('bots.avatar.intake.dropLine', 'Drop to use this image') : null}
      {line.kind === 'saved' ? (
        <>
          <Check className="size-3.5" />
          {t('bots.avatar.intake.saved', 'Picture updated')}
          <span aria-hidden>·</span>
          <LineAction onClick={onUndo}>{t('bots.avatar.intake.undo', 'Undo')}</LineAction>
        </>
      ) : null}
      {line.kind === 'error' ? (
        <span role="alert" className="inline-flex items-center gap-1.5 text-destructive">
          <CircleAlert className="size-3.5" />
          {errorMessage(line.error)}
        </span>
      ) : null}
    </div>
  )
}

/** Over the current face while a picture is dragged in: the drop target. */
export function BotPictureVeil(): React.JSX.Element {
  const t = useTranslate()
  return (
    <span className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 rounded-xl bg-background/60 text-xs font-medium text-foreground ring-[1.5px] ring-foreground/70 backdrop-blur-[2px] ring-inset">
      <ArrowDownToLine className="size-4" />
      {t('bots.avatar.intake.drop', 'Drop to use')}
    </span>
  )
}
