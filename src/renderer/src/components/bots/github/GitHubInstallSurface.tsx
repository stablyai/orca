import React, { useEffect, useSyncExternalStore } from 'react'
import { useBots } from '@/lib/bot-catalog'
import { readBotHostListed, subscribeToBotChanges } from '@/lib/bot-catalog-snapshot'
import {
  closeGitHubInstall,
  expandGitHubInstall,
  gitHubSetupOwner,
  type GitHubInstallRecord
} from '@/lib/bot-github-install-record'
import { hasConnectorResume, useConnectorConnect } from '@/lib/connector-connect-state'
import { useConnectorSetupOpen } from '@/lib/connector-setup-open'
import { BotGitHubSetupDialog } from './BotGitHubSetupDialog'
import { GitHubInstallPill } from './GitHubInstallPill'

/** The setup in progress, as its dialog or minimized to the pill. */
export function GitHubInstallSurface({
  record
}: {
  record: GitHubInstallRecord
}): React.JSX.Element | null {
  // Minimized still counts: an "Open Orca" return lands here instead of sending the owner to Settings.
  useConnectorSetupOpen(true)
  const bot = useBots().find(
    (candidate) => candidate.id === record.bot.id && candidate.hostId === record.bot.hostId
  )
  // Its host listed its bots without it: the bot was deleted, so its setup ends too.
  const hostListed = useSyncExternalStore(subscribeToBotChanges, () =>
    readBotHostListed(record.bot.hostId)
  )
  const gone = !bot && hostListed
  useEffect(() => {
    if (gone) {
      closeGitHubInstall()
    }
  }, [gone])
  // This setup's own sign-in, linked while minimized, brings it back to carry on from it.
  const linked =
    useConnectorConnect(record.bot.hostId, 'github').status === 'linked' &&
    hasConnectorResume(record.bot.hostId, 'github', gitHubSetupOwner(record.bot))
  useEffect(() => {
    if (linked) {
      expandGitHubInstall()
    }
  }, [linked])
  return (
    <>
      {bot ? <BotGitHubSetupDialog bot={bot} record={record} /> : null}
      {/* Until its host's list arrives, the pill stands in for a dialog it cannot build yet. */}
      {record.surface === 'pill' || !bot ? <GitHubInstallPill record={record} /> : null}
    </>
  )
}
