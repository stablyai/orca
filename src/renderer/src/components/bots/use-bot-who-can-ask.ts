// One connector's Who can ask, shared by its views: its people, the requests waiting on it, and
// adding (always confirmed first), removing and reviewing them.
import { useEffect, useEffectEvent, useState } from 'react'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'
import { formatUiRelativeTime } from '@/i18n/relative-time-format'
import {
  decideAccessRequest,
  takeAccessReview,
  useAccessRequests,
  useAccessReview,
  type HostAccessRequest
} from '@/lib/bot-access-requests'
import { updateBot } from '@/lib/bot-catalog'
import { useBotHostOnOwnAccount } from '@/lib/bot-host-orca-account'
import {
  BOT_MAX_MEMBERS,
  botMemberSource,
  type Bot,
  type BotMember
} from '../../../../shared/bot-types'
import type { BotUpdateParams } from '../../../../shared/rpc-contract/bots-params'
import { BOT_ACCESS_COPY } from '../../../../shared/bots/bot-access-copy'
import { readBotMembersFull } from '../../../../shared/bots/bot-member-capacity'
import {
  accessRequestIdentity,
  accessRequestPerson,
  newBotMembers,
  grantAccessRequest
} from '../../../../shared/bots/bot-access-request'
import { useConfirmBotAccess } from './bot-access-confirm'
import { botErrorMessage } from './bot-presentation'
import type { BotWhoCanAskService } from './BotWhoCanAskList'
import { useOrcaCloudSignedOut } from './orca-cloud-signed-out'
import { useBotHostLabel } from './use-bot-host-label'

// A request's row repeats no name: Slack's real name often equals the display name.
export const requestLine = (request: HostAccessRequest): string => {
  const { requester } = request
  const unique =
    requester.detail === accessRequestPerson(request) ? { ...requester, detail: '' } : requester
  return [
    accessRequestIdentity({ ...request, requester: unique }),
    formatUiRelativeTime(request.createdAt - Date.now())
  ]
    .filter(Boolean)
    .join(' · ')
}

/** The Request access asks waiting on this list's connector and workspace. */
export function useWhoCanAskRequests(
  bot: Bot,
  service: BotWhoCanAskService
): readonly HostAccessRequest[] {
  const takes = service.accessRequests
  return useAccessRequests().filter((request) => forList(bot, takes, request))
}

function forList(
  bot: Bot,
  takes: BotWhoCanAskService['accessRequests'],
  request: HostAccessRequest
): boolean {
  return (
    takes !== null &&
    takes !== undefined &&
    request.botId === bot.id &&
    request.hostId === bot.hostId &&
    request.source === takes.source &&
    request.workspaceId === takes.workspaceId
  )
}

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'failed'; message: string; retry: () => void }

/** One connector's Who can ask, for any view of it: its people, the requests waiting, and adding
 *  (always confirmed first), removing and reviewing them. */
export function useBotWhoCanAsk(bot: Bot, service: BotWhoCanAskService) {
  const t = useTranslate()
  const [pickerOpen, setPickerOpen] = useState(false)
  const [save, setSave] = useState<SaveState>({ kind: 'idle' })
  const listed = service.listed(bot.members)
  // The owner is You only when this device runs as the bot's own account; else it is named.
  const onOwnAccount = useBotHostOnOwnAccount(bot.hostId)
  const host = useBotHostLabel(bot.hostId)
  const owner = onOwnAccount
    ? t('bots.whoCanAsk.you', 'You')
    : (service.ownerName ??
      t('bots.whoCanAsk.hostAccount', '{{host}}’s account', { host: host ?? '' }))

  const confirmAccess = useConfirmBotAccess()
  const takes = service.accessRequests
  const forThisList = (request: HostAccessRequest): boolean => forList(bot, takes, request)
  const requests = useWhoCanAskRequests(bot, service)
  const requestsWaitOnSignIn = useOrcaCloudSignedOut(bot.hostId) && takes !== undefined

  // An add past a limit saves nobody; say who and which limit.
  const fullMessage = (error: unknown): string | null => {
    const full = readBotMembersFull(error)
    if (!full) {
      return null
    }
    const values = { names: full.names.join(', '), count: full.limit }
    return full.scope === 'bot'
      ? t(
          'bots.whoCanAsk.fullBot',
          'Nobody was added: {{names}} would go past the {{count}} people a bot can have.',
          values
        )
      : t(
          'bots.whoCanAsk.fullWorkspace',
          'Nobody was added: {{names}} would go past the {{count}} people this workspace can have.',
          values
        )
  }

  // Who Keep only me took off, so Undo can ask to give them access again.
  const [keptOnlyMe, setKeptOnlyMe] = useState<BotMember[] | null>(null)

  // Only this list's change goes to the host, which applies it to the people it has now, so an edit
  // made elsewhere meanwhile is kept. A failed save offers Try again, without asking again.
  const saveMembers = (
    updates: Pick<BotUpdateParams['updates'], 'addMembers' | 'removeMembers'>,
    failed: string,
    saved?: () => void
  ): void => {
    const attempt = (): void => {
      setSave({ kind: 'saving' })
      updateBot(bot, updates).then(
        () => {
          setSave({ kind: 'idle' })
          saved?.()
        },
        (error: unknown) =>
          setSave({ kind: 'failed', message: fullMessage(error) ?? failed, retry: attempt })
      )
    }
    attempt()
  }

  // The picker closes first, so the confirmation is the only thing on screen.
  const add = async (picked: BotMember[], request?: HostAccessRequest): Promise<void> => {
    setPickerOpen(false)
    const confirmed = await confirmAccess(
      {
        botName: bot.name,
        details: { bot, connector: service.kind },
        people: picked.map((member) => ({
          id: member.id,
          name: member.name || member.id,
          ...(request ? { identity: accessRequestIdentity(request) } : {})
        })),
        connector: service.connector,
        workspace: service.workspace
      },
      // A request's Reject declines it; Escape or a press outside leaves it waiting.
      request ? () => void decideAccessRequest(request, 'declined') : undefined
    )
    if (!confirmed) {
      return
    }
    // A request's person is added by the host once the cloud records the grant.
    if (request) {
      await decideAccessRequest(request, 'granted')
      return
    }
    saveMembers(
      { addMembers: newBotMembers(bot.members, picked, service) },
      t('bots.whoCanAsk.addFailed', 'Couldn’t add {{names}}.', {
        names: picked.map((member) => member.name || member.id).join(', ')
      }),
      () => setKeptOnlyMe(null)
    )
  }

  const review = (request: HostAccessRequest): void => {
    const grant = grantAccessRequest(bot, request)
    if (grant.kind === 'listed') {
      void decideAccessRequest(request, 'granted')
      return
    }
    if (grant.kind === 'full') {
      toast.error(
        t('bots.accessRequest.full', BOT_ACCESS_COPY.full, {
          person: accessRequestPerson(request)
        })
      )
      return
    }
    const { id, avatarUrl } = request.requester
    void add(
      [
        {
          id,
          name: accessRequestPerson(request),
          ...(avatarUrl ? { avatarUrl } : {})
        }
      ],
      request
    )
  }

  // The owner's "Review in Orca" link opens straight onto its confirmation.
  const linked = useAccessReview()
  const reviewLinked = useEffectEvent(() => {
    const request = takeAccessReview(forThisList)
    if (request) {
      review(request)
    }
  })
  // Again once the list knows its workspace (Slack's install loads after the page).
  useEffect(() => {
    if (linked) {
      reviewLinked()
    }
  }, [linked, takes?.source, takes?.workspaceId])

  // On the host, as a phone's Remove is, so a concurrent edit is kept.
  const remove = (gone: BotMember): void => {
    void updateBot(bot, {
      removeMember: {
        id: gone.id,
        source: botMemberSource(gone),
        ...(gone.workspaceId ? { workspaceId: gone.workspaceId } : {})
      }
    }).catch((error: unknown) => toast.error(botErrorMessage(error)))
  }
  // Keep only me: everyone this list shows, and nobody another connector lets ask.
  const keepOnlyMe = (): void => {
    const gone = listed
    saveMembers(
      {
        removeMembers: gone.map((member) => ({
          id: member.id,
          source: botMemberSource(member),
          ...(member.workspaceId ? { workspaceId: member.workspaceId } : {})
        }))
      },
      t('bots.whoCanAsk.removeFailed', 'Couldn’t remove the people you added.'),
      () => setKeptOnlyMe(gone)
    )
  }

  const cap = Math.min(service.max, BOT_MAX_MEMBERS - bot.members.length + listed.length)
  return {
    owner,
    listed,
    requests,
    requestsWaitOnSignIn,
    pickerOpen,
    setPickerOpen,
    save,
    saving: save.kind === 'saving',
    cap,
    capped: listed.length >= cap,
    keptOnlyMe,
    add,
    review,
    remove,
    keepOnlyMe,
    decline: (request: HostAccessRequest) => void decideAccessRequest(request, 'declined')
  }
}
