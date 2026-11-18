// New bot's line for a first bot when another app's bots are on this computer: "We found 2 bots in OpenClaw."
import React from 'react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { useBots } from '@/lib/bot-catalog'
import { ownBotHost } from '@/lib/bot-hosts'
import { botImportNudge, useBotImportSources } from './bot-import-sources'

export function BotImportNudge({
  open,
  onImport
}: {
  open: boolean
  onImport: () => void
}): React.JSX.Element | null {
  const t = useTranslate()
  const firstBot = useBots().length === 0
  const read = useBotImportSources(open && firstBot, ownBotHost().hostId)
  const nudge = firstBot && read.status === 'ready' ? botImportNudge(read.sources) : null
  if (!nudge) {
    return null
  }
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-2.5 py-2 text-sm">
      <span className="min-w-0">
        {nudge.count === 1
          ? t('bots.import.nudgeOne', 'We found a bot in {{app}}. Bring it over?', {
              app: nudge.label
            })
          : t('bots.import.nudgeMany', 'We found {{count}} bots in {{app}}. Bring one over?', {
              count: nudge.count,
              app: nudge.label
            })}
      </span>
      <Button type="button" variant="outline" size="xs" className="shrink-0" onClick={onImport}>
        {nudge.count === 1
          ? t('bots.import.nudgeActionOne', 'Bring it over')
          : t('bots.import.nudgeActionMany', 'Bring one over')}
      </Button>
    </div>
  )
}
