import React, { useId } from 'react'
import { BookMarked, Check, ExternalLink, Loader2, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { useGitHubAwait } from '@/lib/bot-github-state'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import {
  GITHUB_INSTALL_FOLLOW,
  type GitHubInstallRecord,
  tripToGitHubInstall
} from '@/lib/bot-github-install-record'
import type { ConnectorGitHubInstallation } from '../../../../../shared/connector-bot-github-contract'
import { ConnectWaiting } from '../connector-connect-parts'
import { gitHubInstallationLabel, gitHubInstallationsSummary } from './bot-github-copy'
import { openGitHubInstallPage } from './github-install-page'
import { GitHubRepositoryGroups } from './github-repository-groups'

/** What a trip to GitHub added to installs the owner already had: new installs, and repositories. */
export function addedFromGitHub(
  before: readonly ConnectorGitHubInstallation[],
  after: readonly ConnectorGitHubInstallation[]
): { newInstalls: Set<string>; names: string[] } {
  const newInstalls = new Set<string>()
  const names: string[] = []
  // A first install is the whole list, nothing to point out.
  if (before.length === 0) {
    return { newInstalls, names }
  }
  for (const installation of after) {
    const was = before.find((old) => old.installationId === installation.installationId)
    if (!was) {
      newInstalls.add(installation.installationId)
      names.push(installation.accountLogin)
    } else if (was.repositories && installation.repositories) {
      const had = new Set(was.repositories.map((repository) => repository.fullName))
      for (const repository of installation.repositories) {
        if (!had.has(repository.fullName)) {
          names.push(repository.fullName)
        }
      }
    }
  }
  return { newInstalls, names }
}

/** What the pill reports once GitHub saved: each repository added, or an organization added whole. */
export function addedOnGitHub(
  before: readonly ConnectorGitHubInstallation[],
  after: readonly ConnectorGitHubInstallation[]
): string[] {
  return after.flatMap((installation) => {
    const was = before.find((old) => old.installationId === installation.installationId)
    if (!installation.repositories) {
      return was ? [] : [installation.accountLogin]
    }
    const had = new Set(was?.repositories?.map((repository) => repository.fullName) ?? [])
    return installation.repositories
      .map((repository) => repository.fullName)
      .filter((name) => !had.has(name))
  })
}

export type GitHubInstallTrip = {
  /** The bot's host, whose GitHub the trip follows. */
  hostId: ExecutionHostId
  /** `before` undefined: the same trip again (Open again). */
  open: (url: string, before: ConnectorGitHubInstallation[] | undefined) => void
  /** The page is in the system browser and GitHub is still being followed. */
  inSystemBrowser: boolean
  before: ConnectorGitHubInstallation[] | null
}

/** The setup's trips to GitHub's install page, kept in its saved record; Orca's browser minimizes it. */
export function useGitHubInstallTrip(record: GitHubInstallRecord): GitHubInstallTrip {
  return {
    hostId: record.bot.hostId,
    open: (url, before) => {
      const opened = openGitHubInstallPage(
        record.bot,
        url,
        Number.POSITIVE_INFINITY,
        GITHUB_INSTALL_FOLLOW
      )
      if (opened) {
        tripToGitHubInstall(record.bot.hostId, opened.destination, opened.wait, before)
      }
    },
    inSystemBrowser: record.waiting && record.inSystemBrowser,
    before: record.before
  }
}

/** GitHub's page is in the system browser: the dialog waits, and can open it again. */
export function GitHubFinishInBrowser({
  trip,
  url
}: {
  trip: GitHubInstallTrip
  url: string
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <ConnectWaiting
      label={t('bots.github.setup.finishInYourBrowser', 'Finish in your browser…')}
      action={
        <Button size="xs" variant="ghost" onClick={() => trip.open(url, undefined)}>
          {t('bots.github.setup.openAgain', 'Open again')}
          <ExternalLink />
        </Button>
      }
    />
  )
}

/** The installs, a way to add more on GitHub's install page, and what the last trip there found. */
export function GitHubInstalledRepositories({
  installations,
  installUrl,
  trip,
  compact = false
}: {
  installations: ConnectorGitHubInstallation[]
  installUrl: string
  trip: GitHubInstallTrip
  /** One summary line with Manage, once the bot is on. */
  compact?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const githubAwait = useGitHubAwait(trip.hostId)
  const added = addedFromGitHub(trip.before ?? [], installations)
  const openInstallPage = (): void => trip.open(installUrl, installations)
  const headingId = useId()
  return (
    <div className="space-y-1">
      {compact ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <BookMarked className="size-4 shrink-0" />
          <span
            className="min-w-0 flex-1 truncate"
            title={installations.map(gitHubInstallationLabel).join(', ')}
          >
            {gitHubInstallationsSummary(installations)}
          </span>
          <Button variant="ghost" size="xs" onClick={openInstallPage}>
            {t('bots.github.setup.manage', 'Manage')}
            <ExternalLink />
          </Button>
        </div>
      ) : (
        <section aria-labelledby={headingId} className="space-y-1.5">
          <div className="flex h-5.5 items-center justify-between gap-2">
            <h3 id={headingId} className="text-xs font-medium text-muted-foreground">
              {t('bots.github.setup.repositories', 'Repositories')}
            </h3>
            <Button
              variant="ghost"
              size="xs"
              className="-mr-1.5"
              aria-label={t('bots.github.setup.addMore', 'Add repositories or an organization')}
              onClick={openInstallPage}
            >
              <Plus />
              {t('bots.github.setup.addShort', 'Add')}
              <ExternalLink />
            </Button>
          </div>
          <GitHubRepositoryGroups installations={installations} newInstalls={added.newInstalls} />
        </section>
      )}
      {trip.inSystemBrowser ? (
        <GitHubFinishInBrowser trip={trip} url={installUrl} />
      ) : githubAwait === 'checking' ? (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {t('bots.github.setup.checkingInstalls', 'Checking GitHub for changes…')}
        </p>
      ) : githubAwait === 'unchanged' ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t(
            'bots.github.setup.noChanges',
            'No new repositories or organizations from GitHub yet.'
          )}
        </p>
      ) : added.names.length > 0 ? (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Check className="size-4 shrink-0" />
          {t('bots.github.setup.added', 'Added from GitHub: {{names}}.', {
            names: added.names.join(', ')
          })}
        </p>
      ) : null}
    </div>
  )
}
