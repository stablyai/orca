// New bot's line for a first bot when another app's bots are on this computer: "We found 2 bots in OpenClaw."
import React, { useState } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { useBots } from '@/lib/bot-catalog'
import { ownBotHost } from '@/lib/bot-hosts'
import { botImportNudge, useBotImportSources } from './bot-import-sources'

const DISMISSED_KEY = 'orca.bots.import-nudge-dismissed'

export function BotImportNudge({
  open,
  onImport
}: {
  open: boolean
  onImport: () => void
}): React.JSX.Element | null {
  const t = useTranslate()
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISSED_KEY) === '1'
    } catch {
      return false
    }
  })
  const firstBot = useBots().length === 0
  const read = useBotImportSources(open && firstBot && !dismissed, ownBotHost().hostId)
  const nudge = firstBot && read.status === 'ready' ? botImportNudge(read.sources) : null
  if (!nudge || dismissed) {
    return null
  }
  const dismissLabel = t('bots.import.nudgeDismiss', "Don't show again")
  return (
    <div className="relative flex items-center justify-between gap-3 rounded-lg border border-border py-2 pr-3 pl-2.5 text-sm">
      <div className="flex min-w-0 items-center gap-2">
        <AgentIcon agent={nudge.app} size={16} className="shrink-0" />
        <span className="min-w-0">
          {nudge.count === 1
            ? t('bots.import.nudgeOne', 'We found a bot in {{app}}.', { app: nudge.label })
            : t('bots.import.nudgeMany', 'We found {{count}} bots in {{app}}.', {
                count: nudge.count,
                app: nudge.label
              })}
        </span>
      </div>
      <Button type="button" variant="outline" size="xs" className="shrink-0" onClick={onImport}>
        {nudge.count === 1
          ? t('bots.import.nudgeActionOne', 'Bring it over')
          : t('bots.import.nudgeActionMany', 'Bring one over')}
      </Button>
      <span className="absolute -top-3 -right-3 flex rounded-full bg-popover">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon-xs-round"
              aria-label={dismissLabel}
              onClick={() => {
                setDismissed(true)
                try {
                  localStorage.setItem(DISMISSED_KEY, '1')
                } catch {
                  // Keep the prompt dismissed for this dialog even when storage is unavailable.
                }
              }}
            >
              <X className="text-muted-foreground" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{dismissLabel}</TooltipContent>
        </Tooltip>
      </span>
    </div>
  )
}
