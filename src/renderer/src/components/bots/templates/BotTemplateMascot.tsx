import type { BotTemplate } from '../../../../../shared/bots/bot-templates'
import { BotAvatarTile } from '../BotAvatar'
import { BOT_MASCOT_URLS } from '../bot-mascots'

/** The mascot a bot made from the template starts with. Decorative: the name always sits beside it. */
export function BotTemplateMascot({
  template,
  className = 'size-8 rounded-lg'
}: {
  template: Pick<BotTemplate, 'mascot'>
  className?: string
}): React.JSX.Element {
  return <BotAvatarTile src={BOT_MASCOT_URLS[template.mascot]} fallback="" className={className} />
}
