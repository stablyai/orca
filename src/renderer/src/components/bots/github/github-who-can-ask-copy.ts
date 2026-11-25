// @protected-copy scope=file
import type { Translate } from '@/i18n/use-translate'

import {
  GITHUB_PEOPLE_PER_SOURCE,
  GITHUB_PERSONAL_REPOSITORIES
} from '../../../../../shared/connector-bot-github-contract'

export const gitHubCheckingUsername = (t: Translate): string =>
  t('bots.github.whoCanAsk.checkingUsername', 'Checking username…')

export const gitHubSnapshotCount = (count: string, snapshot: string, t: Translate): string =>
  t('bots.github.whoCanAsk.snapshotCount', '{{count}} · {{snapshot}}', { count, snapshot })

export function orgSearchCopy(
  {
    reader,
    refresh,
    remote,
    failure,
    limitation,
    omitted,
    exactSearched,
    searchedLine,
    narrow
  }: {
    reader: string | null
    refresh: boolean
    remote: boolean
    failure: string | null
    limitation: string | null
    omitted: boolean
    exactSearched: boolean
    searchedLine: string | null
    narrow: string | null
  },
  t: Translate
) {
  const restart = refresh
    ? remote
      ? t('bots.github.whoCanAsk.refreshListRemote', 'Restart the bot’s Orca')
      : t('bots.github.whoCanAsk.refreshList', 'Restart Orca')
    : null
  const report = (status: string | null): string | undefined => {
    const message =
      status && restart
        ? t('bots.github.whoCanAsk.statusAndRestart', '{{status}} · {{restart}}', {
            status: status.replace(/\.$/, ''),
            restart
          })
        : (status ?? restart)
    if (!reader) {
      return message ?? undefined
    }
    return message
      ? t('bots.github.whoCanAsk.statusAndReader', '{{status}} · read as @{{login}}', {
          status: message.replace(/\.$/, ''),
          login: reader
        })
      : t('bots.github.whoCanAsk.searchedAs', 'People list read as @{{login}}.', { login: reader })
  }
  const partial =
    reader && limitation ? t('bots.github.whoCanAsk.partialList', 'Partial list') : null
  return {
    note: report(failure ?? partial ?? limitation ?? (refresh ? null : narrow)),
    noteAfterTag: report(failure ?? (refresh ? null : narrow)),
    empty:
      report(
        failure ??
          partial ??
          (omitted && exactSearched
            ? t(
                'bots.github.whoCanAsk.skippedSourcesExact',
                'Partial list. Exact usernames checked.'
              )
            : limitation)
      ) ??
      searchedLine ??
      ''
  }
}

/** Why the roster holds only part of its sources' people, by the kind of read that stopped at its
 *  fixed size; typing can't bring those back, so this never advises typing. */
export function cutLine(
  cut: { people: boolean; members: boolean; repositories: boolean },
  t: Translate
): string | null {
  const kinds = [cut.people, cut.members, cut.repositories].filter(Boolean).length
  if (kinds > 1) {
    // Kinds differ (a repo's people, an org's members, a person's repos): say it neutrally.
    return t('bots.github.whoCanAsk.partlyRead', 'Some lists were only partly read.')
  }
  return cut.people
    ? t('bots.github.whoCanAsk.firstPerRepo', 'Showing the first {{count}} people per repo.', {
        count: GITHUB_PEOPLE_PER_SOURCE
      })
    : cut.members
      ? t('bots.github.whoCanAsk.firstPerOrg', 'Showing the first {{count}} members per org.', {
          count: GITHUB_PEOPLE_PER_SOURCE
        })
      : cut.repositories
        ? t('bots.github.whoCanAsk.recentRepos', 'Only your {{count}} latest repos were read.', {
            count: GITHUB_PERSONAL_REPOSITORIES
          })
        : null
}
