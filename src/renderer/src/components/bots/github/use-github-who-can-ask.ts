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
      search: (query) => botGitHubCalls(hostId).users({ query }),
      errorMessage: (code) => botGitHubErrorMessage(code, hostName),
      searchPlaceholder: t('bots.github.whoCanAsk.search', 'Search by GitHub username'),
      peopleHeading: t('bots.github.whoCanAsk.found', 'People on GitHub'),
      noMatch: (query) => ({
        title: t('bots.github.whoCanAsk.noUser', 'No GitHub user named “{{query}}”', {
          query
        }),
        detail: t('bots.github.whoCanAsk.exactOnly', 'GitHub finds people by their exact username.')
      }),
      idleHint: {
        title: t('bots.github.whoCanAsk.typeUsername', 'Type a GitHub username'),
        detail: t('bots.github.whoCanAsk.exactOnly', 'GitHub finds people by their exact username.')
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
    [hostId, hostName, linked, installationId, ownerId, ownerName, t]
  )
}
