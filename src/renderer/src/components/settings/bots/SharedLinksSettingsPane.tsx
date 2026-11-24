import { useTranslate } from '@/i18n/use-translate'
import { BotSharedLinksList } from '../../bots/sharing/BotSharedLinksList'
import { SkillSharedLinksView } from '../../skills/sharing/SkillSharedLinksView'
import { useOwnedSkillShares } from '../../skills/sharing/use-owned-skill-shares'

/** Settings → Shared links: every link the owner published, bots beside skills. */
export function SharedLinksSettingsPane(): React.JSX.Element {
  const t = useTranslate()
  const skillShares = useOwnedSkillShares()
  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h3 className="text-xs font-medium text-muted-foreground">
          {t('settings.sharedLinks.bots', 'Bots')}
        </h3>
        <BotSharedLinksList />
      </section>
      <section className="space-y-2">
        <h3 className="text-xs font-medium text-muted-foreground">
          {t('settings.sharedLinks.skills', 'Skills')}
        </h3>
        <SkillSharedLinksView query="" shares={skillShares} />
      </section>
    </div>
  )
}
