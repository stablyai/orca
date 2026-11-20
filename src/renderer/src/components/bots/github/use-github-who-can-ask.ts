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
  // Search the people of the connected repositories first: those are the owner's teammates.
  // Keyed by content: a state refresh hands over new objects, which must not restart the search.
  const scopeKey = useMemo(() => {
    const repositories: string[] = []
    const organizations: string[] = []
    for (const install of installations ?? []) {
      if (installationId !== undefined && install.installationId !== installationId) {
        continue
      }
      if (install.repositories === null) {
        organizations.push(install.accountLogin)
      } else {
        repositories.push(...install.repositories.map((repo) => repo.fullName))
      }
    }
    return JSON.stringify({ repositories, organizations })
  }, [installations, installationId])
  const scope = useMemo(
    (): { repositories: string[]; organizations: string[] } => JSON.parse(scopeKey),
    [scopeKey]
  )
  return useMemo(
    (): BotWhoCanAskService => ({
      listed: (members) =>
        installationId === undefined
          ? botMembersFrom(members, 'github')
          : gitHubMembersOf(members, installationId),
      stamp:
        installationId === undefined
          ? { source: 'github' }
          : { source: 'github', workspaceId: installationId },
      max: CONNECTOR_CLIENT_LIMITS.maxBotWorkspaceMembers,
      search: (query) => botGitHubCalls(hostId).users({ query, scope }),
      errorMessage: (code) => botGitHubErrorMessage(code, hostName),
      searchPlaceholder: t('bots.github.whoCanAsk.searchPeople', 'Search by name or username'),
      peopleHeading: t('bots.github.whoCanAsk.inRepositories', 'People in your repositories'),
      outsideHeading: t('bots.github.whoCanAsk.elsewhere', 'Elsewhere on GitHub'),
      noMatch: (query) => ({
        title: t('bots.github.whoCanAsk.noPerson', 'No one found for “{{query}}”', { query }),
        detail: t(
          'bots.github.whoCanAsk.searchedWhere',
          'Searched your connected repositories, and GitHub for that exact username.'
        )
      }),
      idleHint: {
        title: t('bots.github.whoCanAsk.typeName', 'Type a name or GitHub username'),
        detail: t(
          'bots.github.whoCanAsk.findHow',
          'Find people in your connected repositories by name, or anyone on GitHub by exact username.'
        )
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
    }),
    [hostId, hostName, linked, installationId, ownerId, ownerName, scope, t]
  )
}
