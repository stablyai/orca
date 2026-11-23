// A bot's picture, edited where it shows: a click opens the picture picker in a popover.
import { useBotHostHas } from '@/lib/bot-host-status'
import {
  BOTS_AVATAR_COLOR_RUNTIME_CAPABILITY,
  BOTS_AVATAR_OUTFIT_RUNTIME_CAPABILITY
} from '../../../../shared/bot-runtime-capabilities'
import { Pencil } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { Bot } from '../../../../shared/bot-types'
import type { useBotPictureSetting } from '../settings/bots/use-bot-picture-setting'
import { BotAvatar } from './BotAvatar'
import { BOT_EDIT_HINT } from './bot-edit-hint'
import { BOT_PICTURE_DROP_OUTLINE, BotPicturePicker, pictureTakesLook } from './BotPicturePicker'

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
  const colors = useBotHostHas(bot.hostId, BOTS_AVATAR_COLOR_RUNTIME_CAPABILITY)
  const outfits = useBotHostHas(bot.hostId, BOTS_AVATAR_OUTFIT_RUNTIME_CAPABILITY)
  // An image (a generated one included, or a mascot this build doesn't know) has no color or outfit
  // here, so the note says only that Slack gets it; an emoji or initial isn't sent, so it gets none.
  const look = pictureTakesLook(picture.value, picture.custom)
  const slackNote = (generating: boolean): React.ReactNode => {
    if (!bot.slack || (!generating && !look && picture.custom?.sentToSlack !== true)) {
      return null
    }
    return (
      <p className="pb-3 text-center text-xs text-muted-foreground">
        {!generating && look && outfits
          ? t('settings.bots.avatarSlackNote', 'Slack gets the picture, not the color or outfit.')
          : !generating && look && colors
            ? t('settings.bots.avatarSlackNoteColor', 'Slack gets the picture, not the color.')
            : t('settings.bots.avatarSlackNotePicture', "Changes your bot's picture in Slack too.")}
      </p>
    )
  }
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
      <PopoverContent
        // A window too short for the open picker scrolls the card; any other fits it whole.
        wheelScroll
        className="flex w-80 flex-col"
      >
        {/* The whole popover takes a dropped picture, so all of it is outlined while one is dragged; the top
            padding matches the gap beside the preview. */}
        <div
          className={cn(
            BOT_PICTURE_DROP_OUTLINE,
            'scrollbar-sleek min-h-0 overflow-x-hidden overflow-y-auto overscroll-contain pt-3'
          )}
        >
          <BotPicturePicker
            value={picture.value}
            custom={picture.custom}
            onChange={picture.pick}
            onUpload={picture.upload}
            onUndo={picture.undo}
            color={picture.color}
            onColorChange={colors ? picture.pickColor : undefined}
            outfit={picture.outfit}
            onOutfitChange={outfits ? picture.pickOutfit : undefined}
            footer={slackNote}
          />
        </div>
      </PopoverContent>
    </Popover>
  )
}
