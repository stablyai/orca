import { useMemo } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { useBotHostLabel } from '../use-bot-host-label'
import { useBotLinearRead } from '@/lib/bot-linear-state'
import { botLinearCalls } from '@/lib/bot-connector-host-calls'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { linearMembersOf, type BotLinear } from '../../../../../shared/bot-types'
import { CONNECTOR_CLIENT_LIMITS } from '../../../../../shared/connectors/connector-cloud-contract'
import type { BotWhoCanAskService } from '../BotWhoCanAskList'
import { botLinearErrorMessage, linearWorkspaceLabel } from './bot-linear-copy'

/** A bot's Linear row › People with access: the people in its Linear workspace the owner lets ask.
 *  Searching a workspace's people needs the owner's Linear account `linked` there. */
export function useLinearWhoCanAsk(
  hostId: ExecutionHostId,
  linear: BotLinear,
  linked: boolean
): BotWhoCanAskService {
  const t = useTranslate()
  const hostName = useBotHostLabel(hostId)
  const { workspaceId } = linear
  const workspaceName = linearWorkspaceLabel(linear.workspaceName, linear.urlKey)
  // The picker sits on the row that already shows the address, so its copy uses the bare name.
  const place = linear.workspaceName || workspaceName
  const view = useBotLinearRead(hostId)
  const owner =
    view.status === 'ready'
      ? view.linear.workspaces.find((entry) => entry.workspaceId === workspaceId)
      : undefined
  const ownerId = owner?.userId ?? null
  const ownerName = owner ? owner.userName || owner.userId : null
  return useMemo(
    (): BotWhoCanAskService => ({
      listed: (members) => linearMembersOf(members, workspaceId),
      stamp: { source: 'linear', workspaceId },
      max: CONNECTOR_CLIENT_LIMITS.maxBotWorkspaceMembers,
      search: (query) => botLinearCalls(hostId).members({ workspaceId, query }),
      errorMessage: (code) => botLinearErrorMessage(code, hostName),
      searchPlaceholder: t('bots.whoCanAsk.searchIn', 'Search people in {{workspace}}', {
        workspace: place
      }),
      peopleHeading: t('bots.whoCanAsk.peopleIn', 'People in {{workspace}}', {
        workspace: place
      }),
      noMatch: (query) => ({
        title: t('bots.whoCanAsk.noOneNamed', 'No one named “{{query}}” in {{workspace}}', {
          query,
          workspace: place
        }),
        detail: t(
          'bots.linear.whoCanAsk.noMatchDetail',
          'Members and guests of {{workspace}}’s Linear can be added. Anyone else gets a public reply to ask you.',
          { workspace: place }
        )
      }),
      ownerId,
      ownerName,
      kind: 'linear',
      connector: 'Linear',
      workspace: workspaceName,
      outsiders: linked
        ? t(
            'bots.linear.whoCanAsk.outsiders',
            'Everyone else in {{workspace}} gets a public reply to ask you.',
            { workspace: workspaceName }
          )
        : null,
      notYet: t(
        'bots.linear.whoCanAsk.needsSetup',
        'Finish setup to link your Linear account in {{workspace}}, then pick people here.',
        { workspace: workspaceName }
      ),
      accessRequests: { source: 'linear', workspaceId }
    }),
    [hostId, hostName, workspaceId, workspaceName, place, linked, ownerId, ownerName, t]
  )
}
