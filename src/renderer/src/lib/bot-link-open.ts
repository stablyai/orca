// "Open in Orca" and "Review in Orca" across this computer and every paired server, as the phone resolves them.
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { selectExecutionHostDisplayLabel } from '@/runtime/hosts/display/execution-host-display-label'
import { useAppStore } from '@/store'
import type { Bot } from '../../../shared/bot-types'
import { BOT_ACCESS_LINK_COPY } from '../../../shared/bots/bot-access-link-copy'
import {
  redeemOnFirstHost,
  resolveAccessRequestNotHere,
  resolveBotLink,
  type BotLinkHostAnswer
} from '../../../shared/bots/bot-link-resolution'
import type { BotAccessRedeemOutcome } from '../../../shared/connector-bot-access-contract'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../shared/execution-host/execution-host'
import { reviewAccessRequest } from './bot-access-requests'
import {
  readBotHostIds,
  readBotHostState,
  readHostBots,
  readLiveBotHostIds,
  readUpdateNeededBotHosts
} from './bot-catalog-snapshot'
import { openBotHome, openBotHomeTab, refreshBots } from './bot-catalog'
import { botHostTarget, botTarget } from './bot-hosts'
import { activateAiVaultStructuredSession } from './agent-session/open/activate-ai-vault-structured-session'
import { isHome } from '../../../shared/bots/bot-homes'
import type { BotDeepLink } from '../../../shared/bot-deep-link'
import { folderWorkspaceKey } from '../../../shared/workspace/identity/workspace-scope'
import { selectFolderWorkspaces } from '@/store/workspaces/catalog/workspace-record-fields'
import { runtimeTargetEnvironmentId } from '@/runtime/rpc/targets/runtime-client-target'

type LinkConversation = NonNullable<BotDeepLink['conversation']>

function sayThreadMissing(): void {
  toast.info(translate('bots.deepLink.missing', "That conversation isn't open on this computer."))
}

/** Every bot host's answer from the catalog: a disconnected server can't say, an older one can't list. */
function botLinkHostAnswers(): BotLinkHostAnswer<Bot, ExecutionHostId>[] {
  return [
    ...readBotHostIds().map((hostId): BotLinkHostAnswer<Bot, ExecutionHostId> => ({
      hostId,
      answer:
        readBotHostState(hostId) === 'live'
          ? { kind: 'bots', bots: readHostBots(hostId) }
          : { kind: 'unreachable' }
    })),
    ...readUpdateNeededBotHosts().map((hostId): BotLinkHostAnswer<Bot, ExecutionHostId> => ({
      hostId,
      answer: { kind: 'no-capability' }
    }))
  ]
}

function hostNames(hostIds: readonly ExecutionHostId[]): string {
  const state = useAppStore.getState()
  return hostIds.map((hostId) => selectExecutionHostDisplayLabel(state, hostId)).join(', ')
}

function sayUnreachable(hostIds: readonly ExecutionHostId[]): void {
  toast.info(
    translate(
      'bots.deepLink.unreachable',
      "Couldn't reach {{hosts}}. The bot may be there; open the link again once it's back.",
      { hosts: hostNames(hostIds) }
    )
  )
}

/** The chat a server bot's home linked to the thread, read fresh from the server's folders. */
async function serverThreadSession(
  bot: Bot,
  conversation: LinkConversation
): Promise<string | null> {
  const store = useAppStore.getState()
  await store.fetchFolderWorkspaces({
    runtimeEnvironmentId: runtimeTargetEnvironmentId(botTarget(bot))
  })
  const home = selectFolderWorkspaces(useAppStore.getState()).find((workspace) =>
    isHome(workspace, [bot])
  )
  const link = home?.externalConversations?.find(
    (entry) => entry.source === conversation.source && entry.externalId === conversation.externalId
  )
  return link?.sessionId ?? null
}

/**
 * Opens the bot on whichever computer lists it. `conversation`: this computer had no chat for the
 * link's thread, so a server's bot opens the server's chat for it. A thread no computer has a chat
 * for (its message never arrived, or the chat is gone) only says so: its Home is a different chat.
 */
export async function openBotLinkHome(
  botId: string,
  conversation: LinkConversation | null
): Promise<void> {
  await refreshBots()
  const resolution = resolveBotLink(botId, botLinkHostAnswers())
  switch (resolution.kind) {
    case 'open': {
      const { hostId, bot } = resolution.match
      if (!conversation) {
        await openBotHomeTab(bot)
        return
      }
      const sessionId =
        hostId === LOCAL_EXECUTION_HOST_ID ? null : await serverThreadSession(bot, conversation)
      if (!sessionId) {
        sayThreadMissing()
        return
      }
      // A server's chat tabs reach this window only once its home is open here, as the sidebar opens it.
      openBotHome(bot)
      await activateAiVaultStructuredSession(
        {
          structuredSession: { workspaceId: folderWorkspaceKey(bot.folderWorkspaceId), sessionId }
        },
        undefined,
        botTarget(bot)
      )
      return
    }
    case 'pick':
      // Ids are random per computer, so two that match can't be told apart from the link.
      toast.info(
        translate(
          'bots.deepLink.pick',
          'More than one computer has a bot for this link: {{hosts}}. Open it from the sidebar.',
          { hosts: hostNames(resolution.matches.map((match) => match.hostId)) }
        )
      )
      return
    case 'unreachable':
      sayUnreachable(resolution.hostIds)
      return
    case 'update-needed':
      toast.info(
        translate('bots.deepLink.updateNeeded', 'Update Orca on {{hosts}} to open this bot here.', {
          hosts: hostNames(resolution.hostIds)
        })
      )
      return
    case 'missing':
      // An unknown or deleted bot opens nothing, as before bare links were read.
      if (conversation) {
        sayThreadMissing()
      }
  }
}

/** The owner's "Review in Orca": each connected computer in turn, until the one with the request's bot takes it. */
export async function openAccessRequestLink(token: string): Promise<void> {
  const outcome = await redeemOnFirstHost(readLiveBotHostIds(), (hostId) =>
    callRuntimeRpc<BotAccessRedeemOutcome>(botHostTarget(hostId), 'bots.access.redeem', {
      token
    }).catch((): BotAccessRedeemOutcome => ({ kind: 'failed' }))
  )
  if (outcome.kind === 'redeemed') {
    reviewAccessRequest({ ...outcome.request, hostId: outcome.hostId })
    return
  }
  if (outcome.kind === 'not-here') {
    const notHere = resolveAccessRequestNotHere(botLinkHostAnswers())
    if (notHere.kind === 'unreachable') {
      sayUnreachable(notHere.hostIds)
      return
    }
  }
  toast.error(
    outcome.kind === 'not-owner'
      ? translate('bots.accessRequest.notOwner', BOT_ACCESS_LINK_COPY.notOwner)
      : outcome.kind === 'expired'
        ? translate('bots.accessRequest.expired', BOT_ACCESS_LINK_COPY.expired)
        : outcome.kind === 'not-here'
          ? translate('bots.accessRequest.notHere', BOT_ACCESS_LINK_COPY.notHere)
          : translate('bots.accessRequest.failed', BOT_ACCESS_LINK_COPY.failed)
  )
}
