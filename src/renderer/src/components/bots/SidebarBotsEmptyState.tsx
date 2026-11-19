import type { JSX } from 'react'
import { LayoutTemplate, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { BotAvatarTile } from './BotAvatar'
import { BOT_MASCOT_URLS } from './bot-mascots'
import { openBotTemplates } from './templates/bot-templates-open'

// Three faces hint at a team of bots, the intro's fleet story in miniature.
const FACES = [BOT_MASCOT_URLS.A1, BOT_MASCOT_URLS.E1, BOT_MASCOT_URLS.M1]

/** The Bots section before the first bot: what a bot is, and the ways to make one. */
export function SidebarBotsEmptyState({ onNewBot }: { onNewBot: () => void }): JSX.Element {
  const t = useTranslate()
  const openModal = useAppStore((s) => s.openModal)

  return (
    <div className="px-2 pb-2">
      <div className="rounded-lg border border-border/70 bg-muted/40 p-3">
        <div className="flex items-center gap-2.5">
          <span className="flex shrink-0 -space-x-1.5" aria-hidden="true">
            {FACES.map((src) => (
              <BotAvatarTile
                key={src}
                src={src}
                fallback=""
                className="size-6 rounded-md ring-2 ring-sidebar"
              />
            ))}
          </span>
          <div className="min-w-0 text-xs font-semibold text-foreground">
            {t('bots.section.emptyTitle', 'Meet your AI teammate')}
          </div>
        </div>
        <p className="mt-2 text-xs leading-[1.45] text-muted-foreground">
          {t(
            'bots.section.emptyBody',
            'Ask from anywhere. It runs a fleet of agents and remembers what it learns.'
          )}{' '}
          <Button
            type="button"
            variant="link"
            size="inlineText"
            onClick={() => openModal('feature-tips', { tipId: 'bots-teammate' })}
          >
            {t('bots.section.emptySeeHow', 'See how it works')}
          </Button>
        </p>
        <div className="mt-2.5 flex gap-1.5">
          <Button type="button" size="xs" className="flex-1" onClick={onNewBot}>
            <Plus className="size-3" />
            {t('bots.section.emptyCreate', 'Create a bot')}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="outline"
            className="flex-1"
            onClick={() => openBotTemplates()}
          >
            <LayoutTemplate className="size-3" />
            {t('bots.section.emptyTemplates', 'Templates')}
          </Button>
        </div>
      </div>
    </div>
  )
}
