// A bot's picture, edited where it shows: a click opens the picture picker in a popover.
import { Pencil } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { Bot } from '../../../../shared/bot-types'
import type { useBotPictureSetting } from '../settings/bots/use-bot-picture-setting'
import { BotAvatar } from './BotAvatar'
import { BOT_EDIT_HINT } from './bot-edit-hint'
import { BOT_PICTURE_DROP_OUTLINE, BotPicturePicker } from './BotPicturePicker'

export function BotPictureButton({
  bot,
  picture,
  avatarClassName,
  className,
  children
}: {
  bot: Bot
  picture: ReturnType<typeof useBotPictureSetting>
  avatarClassName: string
  className?: string
  /** Drawn over the picture, such as its status. */
  children?: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'group/edit relative shrink-0 cursor-pointer rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default',
            className
          )}
          aria-label={t('settings.bots.editPicture', 'Edit bot picture')}
        >
          <BotAvatar bot={bot} className={avatarClassName} />
          <span
            aria-hidden
            className={cn(
              'pointer-events-none absolute inset-0 flex items-center justify-center rounded-[inherit] bg-black/55 text-white',
              BOT_EDIT_HINT
            )}
          >
            <Pencil className="size-1/2 max-h-4 max-w-4" />
          </span>
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80">
        {/* The whole popover takes a dropped picture, so all of it is outlined while one is dragged. */}
        <div className={BOT_PICTURE_DROP_OUTLINE}>
          <BotPicturePicker
            value={picture.value}
            custom={picture.custom}
            onChange={picture.pick}
            onUpload={picture.upload}
            onUndo={picture.undo}
          />
          {bot.slack ? (
            <p className="text-center text-xs text-muted-foreground">
              {t('settings.bots.avatarSlackNote', "Changes your bot's picture in Slack too.")}
            </p>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}
