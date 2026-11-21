// A bot's picture, edited where it shows: a click opens the picture picker in a popover. A picture being
// generated keeps going with the popover closed, the avatar veiled with a spinner, and lands on its own.
import { useRef, useState } from 'react'
import { useBotHostHas } from '@/lib/bot-host-status'
import { BOTS_AVATAR_COLOR_RUNTIME_CAPABILITY } from '../../../../shared/bot-runtime-capabilities'
import { Pencil } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { Bot } from '../../../../shared/bot-types'
import type { useBotPictureSetting } from '../settings/bots/use-bot-picture-setting'
import { BotAvatar } from './BotAvatar'
import { BOT_EDIT_HINT } from './bot-edit-hint'
import { BOT_PICTURE_DROP_OUTLINE, BotPicturePicker } from './BotPicturePicker'
import { useGenerateFace } from './AvatarGenerateFace'
import { useBotPictureGenerating } from './avatar-generation-requests'
import { failedForToast } from './avatar-generation-request-apply'

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
  const generating = useBotPictureGenerating(bot)
  const [open, setOpen] = useState(false)
  // Uploads counted when the last run was asked for: a picture taken in since keeps the slot.
  const uploadsAtGenerate = useRef(0)
  // Above the popover, so a run outlives it. The picture made is uploaded by the request store, behind
  // the host's revision check; here it only takes its place in the slot.
  const face = useGenerateFace(
    () => picture.uploads() === uploadsAtGenerate.current,
    picture.custom?.src
      ? { src: picture.custom.src, description: picture.custom.description }
      : null,
    () => {
      uploadsAtGenerate.current = picture.uploads()
    },
    {
      owner: () => ({ kind: 'bot', bot }),
      background: true,
      // With the picker closed its error can't be seen, so a toast says it; reopened, the picker shows it.
      onFailed: () => {
        if (!open) {
          failedForToast(bot.name)
        }
      }
    }
  )
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip open={generating ? undefined : false}>
        <TooltipTrigger asChild>
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
              {/* While a picture is being made the avatar's own veil and spinner stay instead. */}
              {generating ? null : (
                <span
                  aria-hidden
                  className={cn(
                    'pointer-events-none absolute inset-0 flex items-center justify-center rounded-[inherit] bg-black/55 text-white',
                    BOT_EDIT_HINT
                  )}
                >
                  <Pencil className="size-1/2 max-h-4 max-w-4" />
                </span>
              )}
              {children}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>
          {t('bots.avatar.generate.generating', 'Generating…')}
        </TooltipContent>
      </Tooltip>
      <PopoverContent className="w-80">
        {/* The whole popover takes a dropped picture, so all of it is outlined while one is dragged; the top
            padding matches the gap beside the preview. */}
        <div className={cn(BOT_PICTURE_DROP_OUTLINE, 'pt-3')}>
          <BotPicturePicker
            value={picture.value}
            custom={picture.custom}
            onChange={picture.pick}
            onUpload={picture.upload}
            onUndo={picture.undo}
            color={picture.color}
            onColorChange={colors ? picture.pickColor : undefined}
            generate={face}
            onIntakeStart={picture.beginIntake}
          />
          {bot.slack ? (
            // 8px under the field (whose own 12px bottom inset this pulls up), and the popover's 12px
            // inset under it.
            <p className="-mt-1 pb-3 text-center text-xs text-muted-foreground">
              {t('settings.bots.avatarSlackNote', "Changes your bot's picture in Slack too.")}
            </p>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}
