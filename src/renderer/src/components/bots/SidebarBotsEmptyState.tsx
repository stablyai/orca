import type { JSX } from 'react'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { BotAvatarTile } from './BotAvatar'
import { BOT_MASCOT_URLS } from './bot-mascots'
import { openBotTemplates } from './templates/bot-templates-open'

// Three faces hint at a team of bots, the intro's fleet story in miniature.
const FACES = [BOT_MASCOT_URLS.A1, BOT_MASCOT_URLS.E1, BOT_MASCOT_URLS.M1]

/** The Bots section before the first bot: a raised card with the ways to make one. */
export function SidebarBotsEmptyState({ onNewBot }: { onNewBot: () => void }): JSX.Element {
  const t = useTranslate()

  return (
    <div
      data-bots-onboarding-card=""
      className="mx-2 rounded-[10px] bg-(--bots-onboarding-card) p-3 shadow-xs ring-1 ring-foreground/[0.08] ring-inset [--bots-onboarding-card:var(--background)] dark:shadow-none dark:ring-foreground/10 dark:[--bots-onboarding-card:color-mix(in_srgb,var(--foreground)_7%,var(--sidebar))]"
    >
      {/* The title wraps beside the faces, and drops below them before it would split a word. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <span className="flex shrink-0 -space-x-1" aria-hidden="true">
          {FACES.map((src) => (
            <BotAvatarTile
              key={src}
              src={src}
              fallback=""
              className="size-5 rounded-[5px] ring-2 ring-[var(--bots-onboarding-avatar-ring,var(--bots-onboarding-card))]"
            />
          ))}
        </span>
        <div className="max-w-full grow basis-16 text-[13px] leading-tight font-semibold break-words text-foreground">
          {t('bots.section.emptyCardTitle', 'Your AI teammate')}
        </div>
      </div>
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        <Button type="button" size="xs" onClick={onNewBot}>
          <Plus />
          {t('bots.section.newBot', 'New bot')}
        </Button>
        <Button type="button" size="xs" variant="outline" onClick={() => openBotTemplates()}>
          {t('bots.section.emptyTemplates', 'Templates')}
        </Button>
      </div>
    </div>
  )
}
