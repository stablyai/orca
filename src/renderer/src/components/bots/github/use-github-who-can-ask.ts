import { useMemo } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { useBotHostLabel } from '../use-bot-host-label'
import { useBotGitHubRead } from '@/lib/bot-github-state'
import { botGitHubCalls } from '@/lib/bot-connector-host-calls'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../../shared/execution-host/execution-host'
import { isPairedWebClientWindow } from '@/app-shell/chrome/desktop-window-chrome'
import { botMembersFrom, gitHubMembersOf } from '../../../../../shared/bot-types'
import { gitHubLinkedAccounts } from '../../../../../shared/connector-bot-github-contract'
import { CONNECTOR_CLIENT_LIMITS } from '../../../../../shared/connectors/connector-cloud-contract'
import type { BotWhoCanAskService } from '../BotWhoCanAskList'
import { botGitHubErrorMessage } from './bot-github-copy'
import { gitHubWhoCanAskSession } from './github-who-can-ask-session'
import {
  gitHubPeopleScope,
  type GitHubPeopleScope
} from '../../../../../shared/bots/github-people-scope'

/** A bot's GitHub row › People with access: the GitHub users the owner lets ask it, saved by numeric id.
 *  `linked`: linked and installed, so the bot is reachable on GitHub. `installationId`: one org's row. */
export function useGitHubWhoCanAsk(
  hostId: ExecutionHostId,
  linked: boolean,
  installationId?: string
): BotWhoCanAskService {
  const t = useTranslate()
  const hostName = useBotHostLabel(hostId)
  const view = useBotGitHubRead(hostId)
  const github = view.status === 'ready' ? view.github : null
  // Each linked login is the owner; an org's row names the one that sees it.
  const logins = github ? gitHubLinkedAccounts(github) : []
  const shown =
    (installationId && logins.find((entry) => entry.installations.includes(installationId))) ||
    logins[0]
  const ownerId = shown?.userId ?? null
  const ownerName = shown?.login ?? null
  // Keyed by content, like the scope below: a state refresh with the same accounts hands over new
  // objects, and a new array would rebuild the service and, with it, the open picker's session.
  const otherOwnerKey = logins
    .filter((entry) => entry.userId !== ownerId)
    .map((entry) => entry.userId)
    .join('\n')
  const otherOwnerIds = useMemo(
    () => (otherOwnerKey === '' ? [] : otherOwnerKey.split('\n')),
    [otherOwnerKey]
  )
  // One list is read for every row, so it is keyed by the first linked login, not this row's.
  const rosterOwner = logins[0]?.login ?? null
  const linkedKey = logins.map((entry) => entry.login).join('\n')
  const linkedLogins = useMemo(() => (linkedKey === '' ? [] : linkedKey.split('\n')), [linkedKey])
  const installations = github ? github.installations : null
  // The picker lists the people of every connected repository, for every bot row: a host reads
  // that list once per app run, so it asks for all of it, whichever installation's row this is.
  // Keyed by content: a state refresh hands over new objects, which must not restart the search.
  // Until the GitHub state is read, no scope is sent: unknown, not "nothing connected".
  const scopeKey = useMemo(
    () => (installations === null ? null : JSON.stringify(gitHubPeopleScope(installations))),
    [installations]
  )
  const scope = useMemo(
    (): GitHubPeopleScope | undefined => (scopeKey === null ? undefined : JSON.parse(scopeKey)),
    [scopeKey]
  )
  const withOrganizations = (scope?.owners.length ?? 0) > 0
  return useMemo((): BotWhoCanAskService => {
    const session = () =>
      gitHubWhoCanAskSession(botGitHubCalls(hostId), {
        scope,
        ownerLogin: rosterOwner,
        linkedLogins,
        // Routing, not a friendly name, decides whose Orca holds the list: this window's own
        // computer only for a local bot outside a paired web window.
        producer:
          hostId === LOCAL_EXECUTION_HOST_ID && !isPairedWebClientWindow() ? 'local' : 'remote',
        t
      })
    return {
      listed: (members) =>
        installationId === undefined
          ? botMembersFrom(members, 'github')
          : gitHubMembersOf(members, installationId),
      stamp:
        installationId === undefined
          ? { source: 'github' }
          : { source: 'github', workspaceId: installationId },
      max: CONNECTOR_CLIENT_LIMITS.maxBotWorkspaceMembers,
      search: (query) => session().search(query),
      // One roster read per picker open, filtered as the owner types.
      begin: () => session(),
      errorMessage: (code) => botGitHubErrorMessage(code, hostName),
      searchPlaceholder: t('bots.github.whoCanAsk.searchPeople', 'Search by name or username'),
      peopleHeading: t('bots.github.whoCanAsk.found', 'People on GitHub'),
      scopedHeading: withOrganizations
        ? t('bots.github.whoCanAsk.foundInReposAndOrgs', 'Found in your repos and orgs')
        : t('bots.github.whoCanAsk.foundInRepos', 'Found in your repos'),
      outsideHeading: t('bots.github.whoCanAsk.elsewhere', 'Elsewhere on GitHub'),
      outsideTag: withOrganizations
        ? t('bots.github.whoCanAsk.notFoundInReposOrOrgs', 'Not found in your repos or orgs')
        : t('bots.github.whoCanAsk.notFoundInRepos', 'Not found in your repos'),
      noMatch: (query) => ({
        title: t('bots.github.whoCanAsk.noPerson', 'No one found for “{{query}}”', { query }),
        detail: t('bots.github.whoCanAsk.checkedWhere', 'Searched your repos and exact usernames.')
      }),
      idleHint: {
        title: t('bots.github.whoCanAsk.findPeople', 'Find people'),
        detail: t('bots.github.whoCanAsk.findHow', 'Teammates by name, others by exact username.')
      },
      ownerId,
      otherOwnerIds,
      ownerName,
      kind: 'github',
      connector: 'GitHub',
      workspace: null,
      outsiders: linked
        ? t(
            'bots.github.whoCanAsk.outsiders',
            'Everyone else on GitHub gets a public reply to ask you.'
          )
        : null,
      notYet: t(
        'bots.github.whoCanAsk.needsSetup',
        'Finish setup to link your GitHub account, then pick people here.'
      )
    }
  }, [
    hostId,
    hostName,
    linked,
    installationId,
    ownerId,
    otherOwnerIds,
    ownerName,
    rosterOwner,
    linkedLogins,
    scope,
    withOrganizations,
    t
  ])
}
