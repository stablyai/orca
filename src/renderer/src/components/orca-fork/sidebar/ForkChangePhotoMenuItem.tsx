import React from 'react'
import { ImageUp } from 'lucide-react'
import { toast } from 'sonner'
import { ContextMenuItem } from '@/components/ui/context-menu'
import { useTranslate } from '@/i18n/use-translate'
import { uploadBotAvatar } from '@/lib/bot-catalog'
import type { Bot } from '../../../../../shared/bot-types'
import { FORK_FEATURES } from '../../../../../shared/orca-fork/fork-features'
import {
  avatarPngFromBlob,
  BOT_AVATAR_ACCEPT,
  BotAvatarIntakeFailure
} from '../../bots/bot-avatar-intake'
import { useIntakeErrorMessage } from '../../bots/BotPictureIntakeLine'
import { botErrorMessage } from '../../bots/bot-presentation'

/** "Change photo…" in a bot's row menu: picks an image, crops it square and makes it the bot's picture. */
export function ForkChangePhotoMenuItem({
  bot,
  disabled
}: {
  bot: Bot
  disabled: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  const intakeMessage = useIntakeErrorMessage()
  if (!FORK_FEATURES.sidebarChangePhoto) {
    return null
  }
  const upload = (file: File): void => {
    void avatarPngFromBlob(file)
      .then((png) => uploadBotAvatar(bot, png))
      .then(
        () => toast.success(t('orcaFork.bots.photoChanged', 'Photo changed')),
        (error: unknown) =>
          toast.error(
            error instanceof BotAvatarIntakeFailure
              ? intakeMessage(error.error)
              : botErrorMessage(error)
          )
      )
  }
  const pick = (): void => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = BOT_AVATAR_ACCEPT
    // A detached input: the property handler goes with it, nothing to remove.
    input.onchange = () => {
      const file = input.files?.[0]
      if (file) {
        upload(file)
      }
    }
    input.click()
  }
  return (
    <ContextMenuItem disabled={disabled} onSelect={pick}>
      <ImageUp className="size-3.5" />
      {t('orcaFork.bots.changePhoto', 'Change photo…')}
    </ContextMenuItem>
  )
}
