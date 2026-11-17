// The card a bot shows with `orca bot create --offer`: a new bot it proposes. Nothing is created until the
// owner presses Create bot (or creates it from Edit); the card then reads Created, from the bots there are.
import { useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Pencil } from 'lucide-react'
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
import { botTemplateText } from '../../../../shared/bots/bot-template-text'
import type { BotCardCopyValues } from '../../../../shared/native-chat/bot-cards/bot-card-copy'
import { NativeChatCardFrame, NativeChatCardStatus } from './NativeChatCardFrame'
import { NativeChatCardFact } from './NativeChatCardFact'
import { NativeChatExpandable } from './messages/disclosure/NativeChatExpandable'
import { NativeChatEventOpenButton } from './messages/events/NativeChatEventOpenButton'
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
  askedOne: (t) => t('components.native-chat.botCreateOffer.askedOne', COPY.askedOne),
  askedMany: (t, values) =>
    t('components.native-chat.botCreateOffer.askedMany', COPY.askedMany, values),
  tookOverSome: (t, values) =>
    t('components.native-chat.botCreateOffer.tookOverSome', COPY.tookOverSome, values),
  tookOverOne: (t) => t('components.native-chat.botCreateOffer.tookOverOne', COPY.tookOverOne),
  tookOverMany: (t, values) =>
    t('components.native-chat.botCreateOffer.tookOverMany', COPY.tookOverMany, values),
  deleted: (t) => t('components.native-chat.botCreateOffer.deleted', COPY.deleted),
  nameTaken: (t, values) =>
    t('components.native-chat.botCreateOffer.nameTaken', COPY.nameTaken, values),
  rename: (t) => t('components.native-chat.botCreateOffer.rename', COPY.rename),
  edit: (t) => t('components.native-chat.botCreateOffer.edit', COPY.edit),
  create: (t) => t('components.native-chat.botCreateOffer.create', COPY.create),
  open: (t) => t('components.native-chat.botCreateOffer.open', COPY.open),
  openBot: (t, values) => t('components.native-chat.botCreateOffer.openBot', COPY.openBot, values),
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
  const t = useTranslate()
  const say = sayWith(t)
  return (
    <dl className="mt-3 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1 border-t border-border pt-3">
      {botProposalDetails(proposal, (text) => botTemplateText(text, t)).map((detail) => (
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
  const t = useTranslate()
  const say = sayWith(t)
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
  const view = botCreateOfferView(offer, state, created, taken, say, (text) =>
    botTemplateText(text, t)
  )
  const Chevron = open ? ChevronUp : ChevronDown
  const openCreatedBot = (): void => {
    if (created) {
      void openBotHomeTabById(created)
    }
  }

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
        heading={t('components.native-chat.botCreateOffer.heading', 'New bot')}
        status={
          view.line.kind === 'purpose' ? null : (
            <NativeChatCardStatus tone={view.line.kind === 'created' ? 'success' : 'muted'}>
              {view.line.kind === 'created' ? say('created') : view.line.text}
            </NativeChatCardStatus>
          )
        }
        label={view.title}
        title={
          created ? (
            <span className="inline-flex min-w-0 items-baseline gap-1 [&_button:focus-visible]:ring-2 [&_button:focus-visible]:ring-ring">
              <button
                type="button"
                className="min-w-0 rounded-sm text-left [overflow-wrap:anywhere] hover:underline focus-visible:outline-none"
                onClick={openCreatedBot}
              >
                {view.title}
              </button>
              <NativeChatEventOpenButton
                name={say('openBot', { name: view.title })}
                onOpen={openCreatedBot}
              />
            </span>
          ) : (
            view.title
          )
        }
        footer={
          view.open === null ? undefined : (
            <NativeChatOfferActions
              offer={answering}
              start={
                view.open.actions === 'rename' ? undefined : (
                  <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(true)}>
                    <Pencil aria-hidden />
                    {say('edit')}
                  </Button>
                )
              }
            >
              {view.open.actions === 'rename' ? (
                <Button type="button" size="sm" onClick={() => setEditing(true)}>
                  {say('rename')}
                </Button>
              ) : (
                <Button type="button" size="sm" disabled={creating} onClick={create}>
                  {say('create')}
                </Button>
              )}
            </NativeChatOfferActions>
          )
        }
      >
        <button
          ref={toggle}
          type="button"
          aria-expanded={open}
          aria-label={t('components.native-chat.botCreateOffer.details', 'Details of {{name}}', {
            name: view.title
          })}
          onClick={() => setOpen(!open)}
          className="-mx-1 flex w-[calc(100%+0.5rem)] min-w-0 items-start justify-between gap-2 rounded-md px-1 text-left text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="min-w-0">
            <span className="block">{view.purpose}</span>
            {view.takeover ? <span className="block">{view.takeover}</span> : null}
            {view.open?.note ? <span className="block">{view.open.note}</span> : null}
          </span>
          <Chevron className="mt-0.5 size-4 shrink-0" aria-hidden />
        </button>
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
          origin={botCreateOfferOrigin(proposal, proposer.name, say, (text) =>
            botTemplateText(text, t)
          )}
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
