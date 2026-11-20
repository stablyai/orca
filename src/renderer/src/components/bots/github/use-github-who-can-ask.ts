import { useMemo } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { useBotHostLabel } from '../use-bot-host-label'
import { useBotGitHubRead } from '@/lib/bot-github-state'
import { botGitHubCalls } from '@/lib/bot-connector-host-calls'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { botMembersFrom, gitHubMembersOf } from '../../../../../shared/bot-types'
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
  const account = view.status === 'ready' ? view.github.account : undefined
  const ownerId = account?.userId ?? null
  const ownerName = account?.login ?? null
  const installations = view.status === 'ready' ? view.github.installations : null
  // The picker lists the people of the connected repositories: those are the owner's teammates.
  // Keyed by content: a state refresh hands over new objects, which must not restart the search.
  // Until the GitHub state is read, no scope is sent: unknown, not "nothing connected".
  const scopeKey = useMemo(
    () =>
      installations === null
        ? null
        : JSON.stringify(
            gitHubPeopleScope(
              installations.filter(
                (install) =>
                  installationId === undefined || install.installationId === installationId
              )
            )
          ),
    [installations, installationId]
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
        ownerLogin: ownerName,
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
      search: (query) => session()(query),
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
  }, [hostId, hostName, linked, installationId, ownerId, ownerName, scope, withOrganizations, t])
}
