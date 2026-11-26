// @protected-copy scope=file
// New bot's parts that only a bot from someone else's link has: its copy is fixed, as the dialog's is.
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type { NewBotShareSource } from './new-bot-from-share'

/** The dialog's one link line, in place of a description: whose link it is. */
export function useShareOrigin(source: NewBotShareSource | undefined): string | undefined {
  const t = useTranslate()
  if (!source) {
    return undefined
  }
  const who = source.review.publisher
  return who
    ? t('bots.share.receive.origin', "From {{who}}'s link", { who })
    : t('bots.share.receive.originAnonymous', 'From a shared link')
}

/** Back to the review the bot was made from. */
export function NewBotShareBack({
  source,
  disabled
}: {
  source: NewBotShareSource
  disabled: boolean
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={source.onBack}>
      {t('bots.share.receive.back', 'Back')}
    </Button>
  )
}
