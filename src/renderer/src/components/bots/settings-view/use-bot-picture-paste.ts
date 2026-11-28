// A pasted image becomes the bot's picture, with Undo; text fields keep their own paste.
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'
import type { Bot } from '../../../../../shared/bot-types'
import { useBotPictureSetting } from '../../settings/bots/use-bot-picture-setting'
import { avatarPngFromBlob, BotAvatarIntakeFailure, pastedAvatarSource } from '../bot-avatar-intake'
import { useIntakeErrorMessage } from '../BotPictureIntakeLine'
import { pictureMascotIndex } from '../BotPicturePicker'
import { updateBotReporting } from '../bot-update-reporting'

export function useBotPicturePaste(bot: Bot): (event: React.ClipboardEvent) => void {
  const t = useTranslate()
  const picture = useBotPictureSetting(bot, (updates) => updateBotReporting(bot, updates))
  const intakeError = useIntakeErrorMessage()
  return (event) => {
    const target = event.target
    if (
      target instanceof HTMLElement &&
      (target.isContentEditable || target.closest('input, textarea'))
    ) {
      return
    }
    const image = pastedAvatarSource(event.clipboardData)
    if (!image) {
      return
    }
    event.preventDefault()
    const after =
      picture.value.kind === 'custom' && picture.custom
        ? picture.custom.after
        : pictureMascotIndex(picture.value, picture.custom)
    // A choice as the paste begins, so a picture asked for meanwhile doesn't land on top of it.
    const settle = picture.beginIntake()
    void avatarPngFromBlob(image)
      .then(
        (png) => {
          picture.upload(png, after)
          toast.success(t('bots.avatar.intake.saved', 'Picture updated'), {
            action: { label: t('bots.avatar.intake.undo', 'Undo'), onClick: picture.undo }
          })
        },
        (error: unknown) => {
          if (error instanceof BotAvatarIntakeFailure) {
            toast.error(intakeError(error.error))
          }
        }
      )
      .finally(settle)
  }
}
