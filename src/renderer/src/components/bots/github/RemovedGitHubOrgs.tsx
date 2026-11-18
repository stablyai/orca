import React from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { updateBot } from '@/lib/bot-catalog'
import { useBotGitHub } from '@/lib/bot-github-state'
import type { Bot } from '../../../../../shared/bot-types'
import { botErrorMessage } from '../bot-presentation'

/** Orgs taken off the bot that still have Orca installed: Add back puts the bot there again, no GitHub trip. */
export function RemovedGitHubOrgs({ bot }: { bot: Bot }): React.JSX.Element | null {
  const t = useTranslate()
  const view = useBotGitHub(bot.hostId)
  const removed = bot.github?.removedInstallationIds ?? []
  const orgs =
    view.status === 'ready'
      ? view.github.installations.filter((entry) => removed.includes(entry.installationId))
      : []
  if (orgs.length === 0) {
    return null
  }
  return (
    <>
      {orgs.map((org) => (
        <li
          key={org.installationId}
          className="flex items-center gap-3 rounded-md py-1.5 pr-3 pl-14 text-foreground"
        >
          <span className="min-w-0 flex-1 truncate text-sm">{org.accountLogin}</span>
          <Button
            size="sm"
            variant="secondary"
            aria-label={t('bots.connectors.addBackNamed', 'Add {{name}} back', {
              name: org.accountLogin
            })}
            onClick={() =>
              void updateBot(bot, {
                github: {
                  removedInstallationIds: removed.filter((id) => id !== org.installationId)
                }
              }).catch((error: unknown) => toast.error(botErrorMessage(error)))
            }
          >
            {t('bots.connectors.addBack', 'Add back')}
          </Button>
        </li>
      ))}
    </>
  )
}
