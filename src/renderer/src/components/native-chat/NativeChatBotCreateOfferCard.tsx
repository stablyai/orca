// The card a bot shows with `orca bot create --offer`: a new bot it proposes. Nothing is created until the
// owner presses Create bot (or creates it from Edit); the card then reads Created, from the bots there are.
import { useRef, useState } from 'react'
import { Check, ChevronDown, ChevronUp } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { createBot, openBotHomeTabById, useBots } from '@/lib/bot-catalog'
import { botHostHas } from '@/lib/bot-host-status'
import { BOTS_TEMPLATES_RUNTIME_CAPABILITY } from '../../../../shared/bot-runtime-capabilities'
import { BotAvatar, BotAvatarTile } from '../bots/BotAvatar'
import { BOT_MASCOT_URLS } from '../bots/bot-mascots'
import { botErrorMessage } from '../bots/bot-presentation'
import { NewBotDialog } from '../bots/NewBotDialog'
import { isBotMascotId } from '../../../../shared/bot-avatar'
import type { Bot } from '../../../../shared/bot-types'
import {
  botCreateOfferState,
  proposalCreateParams,
  type BotCreateOffer,
  type BotProposal
} from '../../../../shared/bots/bot-proposal'
import { useAppStore } from '@/store'
import {
  BOT_CREATE_OFFER_COPY,
  botCreateOfferOrigin,
  botCreateOfferTakenOver,
  botCreateOfferView,
  botProposalDetails,
  type BotCreateOfferSay
} from '../../../../shared/bots/bot-create-offer-view'
import type { BotCardCopyValues } from '../../../../shared/native-chat/bot-cards/bot-card-copy'
import { NativeChatCardFrame } from './NativeChatCardFrame'
import { NativeChatCardFact } from './NativeChatAutomationCardDetails'
import { NativeChatExpandable } from './messages/disclosure/NativeChatExpandable'
import { NativeChatOfferActions, useNativeChatOffer } from './NativeChatOfferActions'
import { useNativeChatDisclosure } from './messages/disclosure/native-chat-disclosure-store'

// Every new-bot card in a chat shares this prefix, so opening one closes the rest.
const BOT_CREATE_CARD_DISCLOSURE = 'bot-create-card:'

const COPY = BOT_CREATE_OFFER_COPY
const PIECES: Record<keyof typeof COPY, (t: Translate, values?: BotCardCopyValues) => string> = {
  takesOverOne: (t) => t('components.native-chat.botCreateOffer.takesOverOne', COPY.takesOverOne),
  takesOverMany: (t, values) =>
    t('components.native-chat.botCreateOffer.takesOverMany', COPY.takesOverMany, values),
  created: (t) => t('components.native-chat.botCreateOffer.created', COPY.created),
  createdAskedOne: (t) =>
    t('components.native-chat.botCreateOffer.createdAskedOne', COPY.createdAskedOne),
  createdAskedMany: (t, values) =>
    t('components.native-chat.botCreateOffer.createdAskedMany', COPY.createdAskedMany, values),
  createdTookOverSome: (t, values) =>
    t(
      'components.native-chat.botCreateOffer.createdTookOverSome',
      COPY.createdTookOverSome,
      values
    ),
  createdTookOverOne: (t) =>
    t('components.native-chat.botCreateOffer.createdTookOverOne', COPY.createdTookOverOne),
  createdTookOverMany: (t, values) =>
    t(
      'components.native-chat.botCreateOffer.createdTookOverMany',
      COPY.createdTookOverMany,
      values
    ),
  deleted: (t) => t('components.native-chat.botCreateOffer.deleted', COPY.deleted),
  nameTaken: (t, values) =>
    t('components.native-chat.botCreateOffer.nameTaken', COPY.nameTaken, values),
  rename: (t) => t('components.native-chat.botCreateOffer.rename', COPY.rename),
  edit: (t) => t('components.native-chat.botCreateOffer.edit', COPY.edit),
  create: (t) => t('components.native-chat.botCreateOffer.create', COPY.create),
  open: (t) => t('components.native-chat.botCreateOffer.open', COPY.open),
  origin: (t, values) => t('components.native-chat.botCreateOffer.origin', COPY.origin, values),
  originTemplate: (t, values) =>
    t('components.native-chat.botCreateOffer.originTemplate', COPY.originTemplate, values),
  watches: (t) => t('components.native-chat.botCreateOffer.watches', COPY.watches),
  does: (t) => t('components.native-chat.botCreateOffer.does', COPY.does),
  reports: (t) => t('components.native-chat.botCreateOffer.reports', COPY.reports),
  willPropose: (t) => t('components.native-chat.botCreateOffer.willPropose', COPY.willPropose),
  takesOver: (t) => t('components.native-chat.botCreateOffer.takesOver', COPY.takesOver),
  template: (t) => t('components.native-chat.botCreateOffer.template', COPY.template)
}
function sayWith(t: Translate): BotCreateOfferSay {
  return (id, values) => PIECES[id](t, values)
}

/** How many of the asked-for workspaces are under the new bot now. */
function useTakenOver(bot: Bot | undefined, worktrees: BotProposal['worktrees']): number {
  return useAppStore((state) =>
    botCreateOfferTakenOver(
      bot,
      worktrees,
      (child) => state.workspaceLineageByChildKey[child]?.parentWorkspaceKey
    )
  )
}

/** A proposed bot's picture: its mascot, else its initial. Also drawn on Bot templates' suggestions. */
export function ProposalAvatar({
  proposal,
  className = 'mt-0.5 size-8 rounded-lg'
}: {
  proposal: BotProposal
  className?: string
}): React.JSX.Element {
  const src =
    proposal.mascot && isBotMascotId(proposal.mascot) ? BOT_MASCOT_URLS[proposal.mascot] : null
  return (
    <BotAvatarTile
      src={src}
      fallback={proposal.name.slice(0, 1).toUpperCase()}
      className={className}
    />
  )
}

/** What a proposed bot would watch, do and report, under its card's Details. */
export function ProposalDetails({ proposal }: { proposal: BotProposal }): React.JSX.Element {
  const say = sayWith(useTranslate())
  return (
    <dl className="mt-3 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1 border-t border-border pt-3">
      {botProposalDetails(proposal).map((detail) => (
        <NativeChatCardFact key={detail.label} label={say(detail.label)}>
          {detail.text}
        </NativeChatCardFact>
      ))}
    </dl>
  )
}

function OfferCard({
  offer,
  proposer,
  bots,
  messageId
}: {
  offer: BotCreateOffer
  proposer: Bot
  bots: readonly Bot[]
  messageId: string
}): React.JSX.Element {
  const say = sayWith(useTranslate())
  useTranslation()
  const answering = useNativeChatOffer(proposer.id, messageId)
  const { proposal } = offer
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState(false)
  const { open, setOpen } = useNativeChatDisclosure(
    messageId ? `${BOT_CREATE_CARD_DISCLOSURE}${messageId}` : undefined,
    false,
    BOT_CREATE_CARD_DISCLOSURE
  )
  const toggle = useRef<HTMLButtonElement>(null)
  const state = botCreateOfferState(offer, proposer, bots)
  const created = state.kind === 'created' ? bots.find((bot) => bot.id === state.botId) : undefined
  const fromOffer = { botId: proposer.id, offerId: offer.offerId }
  const taken = useTakenOver(created, proposal.worktrees)
  const view = botCreateOfferView(offer, state, created, taken, say)
  const Chevron = open ? ChevronUp : ChevronDown

  const create = (): void => {
    setCreating(true)
    // The new bot runs on the agent its proposer runs on, which the owner already uses.
    void createBot(
      proposer.hostId,
      proposalCreateParams(proposal, proposer.agent, {
        templatePackages: botHostHas(proposer.hostId, BOTS_TEMPLATES_RUNTIME_CAPABILITY),
        fromOffer
      })
    )
      .catch((error: unknown) => toast.error(botErrorMessage(error)))
      .finally(() => setCreating(false))
  }

  return (
    <div
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.preventDefault()
          event.stopPropagation()
          setOpen(false)
          toggle.current?.focus()
        }
      }}
    >
      <NativeChatCardFrame
        avatar={
          created ? (
            <BotAvatar bot={created} className="mt-0.5 size-8 rounded-lg" />
          ) : (
            <ProposalAvatar proposal={proposal} />
          )
        }
      >
        <div className="flex items-end justify-between gap-3">
          <button
            ref={toggle}
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="flex min-w-0 flex-1 items-end justify-between gap-2 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-foreground">
                {view.title}
              </span>
              {view.line.kind === 'created' ? (
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Check className="size-3" aria-hidden />
                  {view.line.text}
                </span>
              ) : (
                <span className="block text-xs text-muted-foreground">{view.line.text}</span>
              )}
            </span>
            <Chevron className="mb-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          </button>
          {created ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="shrink-0"
              onClick={() => void openBotHomeTabById(created)}
            >
              {say('open')}
            </Button>
          ) : null}
        </div>
        {view.open === null ? null : (
          // Narrow, the buttons wrap under the line rather than cutting it.
          <div className="mt-2 flex flex-wrap items-center justify-end gap-x-3 gap-y-1.5">
            <p className="mr-auto text-xs text-muted-foreground">{view.open.note}</p>
            <NativeChatOfferActions offer={answering} done={false}>
              {view.open.actions === 'rename' ? (
                <Button type="button" variant="outline" size="xs" onClick={() => setEditing(true)}>
                  {say('rename')}
                </Button>
              ) : (
                <>
                  <Button type="button" variant="ghost" size="xs" onClick={() => setEditing(true)}>
                    {say('edit')}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    disabled={creating}
                    onClick={create}
                  >
                    {say('create')}
                  </Button>
                </>
              )}
            </NativeChatOfferActions>
          </div>
        )}
        <NativeChatExpandable open={open}>
          {open ? <ProposalDetails proposal={proposal} /> : null}
        </NativeChatExpandable>
      </NativeChatCardFrame>
      {editing ? (
        <NewBotDialog
          open
          onOpenChange={setEditing}
          proposal={proposal}
          fromOffer={fromOffer}
          offerHostId={proposer.hostId}
          origin={botCreateOfferOrigin(proposal, proposer.name, say)}
        />
      ) : null}
    </div>
  )
}

export function NativeChatBotCreateOfferCard({
  offer,
  messageId,
  fallback
}: {
  offer: BotCreateOffer
  messageId: string
  /** The host's line, for a bot this window doesn't list. */
  fallback: string
}): React.JSX.Element {
  const bots = useBots()
  const proposer = bots.find((entry) => entry.id === offer.botId)
  if (!proposer) {
    return <p className="text-sm text-chat-foreground-faint">{fallback}</p>
  }
  return <OfferCard offer={offer} proposer={proposer} bots={bots} messageId={messageId} />
}
