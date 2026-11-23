import React, { useEffect, useState } from 'react'
import { Trans } from 'react-i18next'
import { GitHubIcon } from '@/components/icons/GitHubIcon'
import { i18n } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { useBotGitHubRead } from '@/lib/bot-github-state'
import {
  closeGitHubInstall,
  expandGitHubInstall,
  gitHubInstallChanged,
  type GitHubInstallRecord
} from '@/lib/bot-github-install-record'
import { useConnectorConnect } from '@/lib/connector-connect-state'
import { ConnectorSetupPill } from '../connector-setup-surface'
import { addedOnGitHub } from './github-install-trip'

const GITHUB = { id: 'github', Icon: GitHubIcon } as const
// Long enough to read what GitHub saved before the dialog opens on it.
const AUTO_EXPAND_MS = 1_400

/** Setup minimized: bottom centre of the window, over every pane, until Expand, ✕, or GitHub saves. */
export function GitHubInstallPill({ record }: { record: GitHubInstallRecord }): React.JSX.Element {
  const t = useTranslate()
  const view = useBotGitHubRead(record.bot.hostId)
  const connecting = useConnectorConnect(record.bot.hostId, 'github').status === 'waiting'
  const changed = !record.waiting && gitHubInstallChanged(record, view)
  const done = record.turnedOn || changed
  // Only a save that lands while the pill is up opens the dialog by itself, not one the owner already saw.
  const [changedOnShow] = useState(changed)
  const autoExpand = changed && !changedOnShow && !record.turnedOn
  useEffect(() => {
    if (!autoExpand) {
      return undefined
    }
    const timer = setTimeout(expandGitHubInstall, AUTO_EXPAND_MS)
    return () => clearTimeout(timer)
  }, [autoExpand])

  const name = (
    <span className="min-w-0 truncate" title={record.botName}>
      {record.botName}
    </span>
  )
  const added =
    changed && record.before && view.status === 'ready'
      ? addedOnGitHub(record.before, view.github.installations)
      : []
  // Only the bot's name gives way, so "to GitHub" always shows.
  const text = record.turnedOn ? (
    <Trans
      i18n={i18n}
      defaults={t('bots.github.pill.on', '<name/> is on GitHub')}
      components={{ name }}
    />
  ) : changed ? (
    <span className="min-w-0 truncate">
      {added.length === 0
        ? t('bots.github.pill.saved', 'GitHub saved your changes')
        : added.every((entry) => entry.includes('/'))
          ? t('bots.github.pill.addedRepositories', 'Added {{count}} repositories', {
              count: added.length,
              defaultValue_one: 'Added {{count}} repository'
            })
          : t('bots.github.pill.added', 'Added {{names}}', { names: added.join(', ') })}
    </span>
  ) : (
    <Trans
      i18n={i18n}
      defaults={t('bots.github.pill.adding', 'Adding <name/> to GitHub')}
      components={{ name }}
    />
  )
  return (
    <ConnectorSetupPill
      connector={GITHUB}
      text={text}
      badge={done ? 'done' : record.waiting || connecting ? 'waiting' : null}
      done={done}
      stopLabel={t('bots.github.pill.stop', 'Stop adding {{name}} to GitHub', {
        name: record.botName
      })}
      onExpand={expandGitHubInstall}
      onStop={closeGitHubInstall}
    />
  )
}
