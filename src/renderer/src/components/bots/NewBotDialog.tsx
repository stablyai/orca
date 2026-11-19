import React, { useRef, useState } from 'react'
import { toast } from 'sonner'
import { LayoutTemplate } from 'lucide-react'
import { useAppStore } from '@/store'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { ImeInput } from '@/lib/text-input/ime/ime-text-field'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { createBot } from '@/lib/bot-catalog'
import { isScreenSubmitShortcut } from '@/lib/keyboard/screen-submit-shortcut'
import { BOT_NAME_MAX_LENGTH, type Bot, type BotAgent } from '../../../../shared/bot-types'
import { botErrorMessage } from './bot-presentation'
import { BotRunsOnPicker } from './BotRunsOnPicker'
import { BotImportNudge } from './BotImportNudge'
import { openCreatedBot } from './bot-create-open'
import { BotPicturePicker } from './BotPicturePicker'
import { useNewBotPicture } from './use-new-bot-picture'
import { useBotAgentMenu } from './use-bot-agent-choices'
import { useBotCreateHost } from './bot-create-hosts'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import { useBotAgentSetup } from './use-bot-agent-setup'
import { proposalCreateParams, type BotProposal } from '../../../../shared/bots/bot-proposal'
import {
  BOTS_AVATAR_COLOR_RUNTIME_CAPABILITY,
  BOTS_TEMPLATES_RUNTIME_CAPABILITY
} from '../../../../shared/bot-runtime-capabilities'
import { useBotHostHas } from '@/lib/bot-host-status'
import { botTemplate, type BotTemplateSkill } from '../../../../shared/bots/bot-templates'
import { NewBotTemplateParts } from './NewBotTemplateParts'
import type { BotCreateParams } from '../../../../shared/rpc-contract/bots-params'
import { NewBotProposalFields, type NewBotProposalDraft } from './NewBotProposalFields'
import { NewBotPurposeField } from './NewBotPurposeField'
import { BotCreateButton } from './BotCreateButton'
import { BARE_HEADING_CLASS, keyboardNavMarkerHandlers } from './new-bot-bare-fields'
import { openBotTemplates } from './templates/bot-templates-open'

type NewBotDraft = NewBotProposalDraft & { purpose: string }

const draftOf = (proposal: BotProposal | undefined, purpose?: string): NewBotDraft => ({
  purpose: proposal?.purpose ?? purpose ?? '',
  watches: proposal?.watches,
  does: proposal?.does,
  reports: proposal?.reports
})

// An emptied field drops out of the new bot's SOUL.md.
const trimmedDraft = (draft: NewBotProposalDraft): NewBotProposalDraft => ({
  watches: draft.watches?.trim() || undefined,
  does: draft.does?.trim() || undefined,
  reports: draft.reports?.trim() || undefined
})

/** What the new bot is made from: the proposal as edited, or a typed purpose on its own. Either seeds
 *  SOUL.md; a cleared purpose keeps the proposal's, which its other lines need. */
function editedProposal(
  proposal: BotProposal | undefined,
  draft: NewBotDraft,
  name: string
): BotProposal | null {
  const purpose = draft.purpose.trim()
  if (proposal) {
    return { ...proposal, ...trimmedDraft(draft), name, purpose: purpose || proposal.purpose }
  }
  return purpose ? { name, purpose } : null
}

export function NewBotDialog({
  open,
  onOpenChange,
  onCreated,
  initialName,
  initialPurpose,
  initialAgent,
  takingOver,
  proposal,
  fromOffer,
  origin,
  returnFocusTo,
  onImport,
  hosts,
  offerHostId
}: {
  open: boolean
  /** Closed with `made` once that bot is created, else dismissed. */
  onOpenChange: (open: boolean, made?: Bot) => void
  onCreated?: (bot: Bot) => void
  /** A suggested name; mount the dialog when it opens so the suggestion is fresh. */
  initialName?: string
  /** A suggested purpose, seeded into SOUL.md like a typed one. */
  initialPurpose?: string
  /** The agent picked at first, when this computer has it. */
  initialAgent?: BotAgent
  /** Made in Hand to bot: `onCreated` sends its first turn, once the workspace moved, even when its
   *  page could not open. */
  takingOver?: true
  /** A proposed bot (a template, a suggestion, a bot's card): prefills the dialog, and its purpose seeds
   *  the new bot's SOUL.md. Mount the dialog when it opens. */
  proposal?: BotProposal
  /** The bot-create card the proposal came from: the new bot is recorded against it. */
  fromOffer?: BotCreateParams['fromOffer']
  /** Where the proposal came from ("From Support triage, for your work"), in place of the description. */
  origin?: string
  /** Opened programmatically, it has no trigger to give focus back to on Cancel; this takes its place. */
  returnFocusTo?: React.RefObject<HTMLElement | null>
  /** Offers bringing a bot over from another app instead, when this is the owner's first bot. */
  onImport?: () => void
  /** The computers it may go on; every one by default. */
  hosts?: readonly ExecutionHostId[]
  /** The computer of the bot that proposed it (`fromOffer`): picked first. Made on another computer,
   *  it is a plain new bot, since that bot and the workspaces it named aren't there. */
  offerHostId?: ExecutionHostId
}): React.JSX.Element {
  const t = useTranslate()
  const nameRef = useRef<HTMLInputElement>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const [name, setName] = useState(proposal?.name ?? initialName ?? '')
  const [draft, setDraft] = useState(() => draftOf(proposal, initialPurpose))
  const hostChoice = useBotCreateHost(open, hosts, offerHostId)
  const { hostId, blocked } = hostChoice.host
  const menu = useBotAgentMenu(hostId, open)
  const { choices } = menu
  const agentSetup = useBotAgentSetup(choices, hostId, initialAgent)
  const [creating, setCreating] = useState(false)
  const canCreate = !creating && !blocked && choices.length > 0
  const createdBot = useRef(false)
  const picture = useNewBotPicture(
    useBotHostHas(hostId, BOTS_AVATAR_COLOR_RUNTIME_CAPABILITY),
    proposal?.mascot
  )
  // From Bot templates itself (Blank bot), the row would only lead back to it.
  const fromTemplates = useAppStore((state) => state.activeModal === 'bot-templates')
  const trimmedName = name.trim()
  // From a template: what it comes with, its skills kept unless unticked; an older host takes the seed only.
  const template = botTemplate(proposal?.templateId)
  const templatePackages = useBotHostHas(hostId, BOTS_TEMPLATES_RUNTIME_CAPABILITY)
  const [kept, setKept] = useState<ReadonlySet<BotTemplateSkill>>(
    () => new Set(template?.skills ?? [])
  )

  const close = (made?: Bot): void => {
    setName(proposal?.name ?? '')
    setDraft(draftOf(proposal, initialPurpose))
    agentSetup.reset()
    picture.reset()
    hostChoice.reset()
    onOpenChange(false, made)
  }
  const handleOpenChange = (next: boolean): void => {
    if (creating) {
      return
    }
    if (next) {
      onOpenChange(true)
    } else {
      close()
    }
  }

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    // No name is fine: the runtime names it "New bot", numbered past ones already there.
    if (!canCreate) {
      return
    }
    setCreating(true)
    let bot: Bot
    try {
      const made = editedProposal(proposal, draft, trimmedName)
      const offerHere = hostId === (offerHostId ?? LOCAL_EXECUTION_HOST_ID)
      bot = await createBot(hostId, {
        ...(made
          ? proposalCreateParams(
              offerHere ? made : { ...made, worktrees: undefined },
              agentSetup.setup.agent,
              {
                templatePackages,
                skills: [...kept],
                fromOffer: offerHere ? fromOffer : undefined
              }
            )
          : { name: trimmedName }),
        ...agentSetup.setup,
        avatar: picture.avatar,
        avatarColor: picture.avatarColor,
        ...(takingOver ? { takingOver } : {})
      })
      bot = await picture.saveUpload(bot)
    } catch (error) {
      setCreating(false)
      toast.error(botErrorMessage(error))
      return
    }
    // Closes once the bot exists, as a new workspace's composer does; its page opens next and shows
    // its agent starting.
    createdBot.current = true
    setCreating(false)
    close(bot)
    void openCreatedBot(bot).then((opened) => {
      if (opened || takingOver) {
        onCreated?.(bot)
      }
    })
  }

  const showTemplateLink = !proposal && !fromTemplates && !name && !draft.purpose

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className={cn(
          'max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md grid-rows-[auto_minmax(0,1fr)] sm:max-w-md',
          proposal && 'max-w-xl sm:max-w-xl'
        )}
        {...keyboardNavMarkerHandlers}
        onOpenAutoFocus={(event) => {
          // The name, not Radix's first tabbable (the picture arrows), so typing names the bot.
          event.preventDefault()
          nameRef.current?.focus()
        }}
        onCloseAutoFocus={(event) => {
          // The new bot's page is opening and its composer takes focus; the New bot button must not.
          if (createdBot.current) {
            createdBot.current = false
            event.preventDefault()
          } else if (returnFocusTo?.current) {
            event.preventDefault()
            returnFocusTo.current.focus()
          }
        }}
      >
        <DialogHeader className="sm:text-center">
          <DialogTitle>{t('bots.new.title', 'New bot')}</DialogTitle>
          <DialogDescription>
            {origin ??
              t(
                'bots.new.description',
                'Your AI teammate, with a name, memory and automations. It lives in a folder on one computer.'
              )}
          </DialogDescription>
        </DialogHeader>
        <form
          ref={formRef}
          className="flex min-h-0 flex-col gap-4"
          onSubmit={(event) => void handleSubmit(event)}
          onKeyDown={(event) => {
            if (
              isScreenSubmitShortcut(event) &&
              event.target instanceof Node &&
              event.currentTarget.contains(event.target)
            ) {
              event.preventDefault()
              formRef.current?.requestSubmit()
            }
          }}
        >
          <div className="-mx-4 -mt-3 min-h-0 space-y-4 overflow-x-hidden overflow-y-auto px-4 pt-3 scrollbar-sleek">
            {/* The nudge reads this computer's other apps, so it shows only while this computer is picked. */}
            {onImport && hostId === LOCAL_EXECUTION_HOST_ID ? (
              <BotImportNudge
                open={open}
                onImport={() => {
                  close()
                  onImport()
                }}
              />
            ) : null}
            <BotPicturePicker
              value={picture.value}
              custom={picture.custom}
              onChange={picture.onChange}
              onUpload={picture.onUpload}
              color={picture.color}
              onColorChange={picture.onColorChange}
              uploadLink
            />
            <div className="space-y-1">
              <ImeInput
                ref={nameRef}
                className={BARE_HEADING_CLASS}
                aria-label={t('bots.new.name', 'Name')}
                autoComplete="off"
                spellCheck={false}
                value={name}
                maxLength={BOT_NAME_MAX_LENGTH}
                placeholder={t('bots.new.namePlaceholder', 'Name your bot')}
                onChange={(event) => setName(event.target.value)}
              />
              <NewBotPurposeField
                value={draft.purpose}
                onChange={(purpose) => setDraft({ ...draft, purpose })}
              />
            </div>
            <BotRunsOnPicker
              variant="caption"
              hostChoice={hostChoice}
              setup={agentSetup.setup}
              model={menu.model}
              choices={choices}
              onSetupChange={agentSetup.setSetup}
            />
            {proposal ? (
              <div className="border-t border-border pt-4">
                <NewBotProposalFields
                  draft={draft}
                  worktrees={proposal.worktrees}
                  onChange={(fields) => setDraft({ ...draft, ...fields })}
                />
              </div>
            ) : null}
            {template ? (
              <NewBotTemplateParts
                template={template}
                packages={templatePackages}
                hostLabel={hostChoice.host.label}
                kept={kept}
                onKeptChange={(skill, on) => {
                  const next = new Set(kept)
                  if (on) {
                    next.add(skill)
                  } else {
                    next.delete(skill)
                  }
                  setKept(next)
                }}
              />
            ) : null}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-3 pt-1">
            {/* It closes this dialog, so it shows only before anything is typed. */}
            {showTemplateLink ? (
              <button
                type="button"
                onClick={() => {
                  close()
                  openBotTemplates()
                }}
                className="flex items-center gap-1.5 rounded-sm text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <LayoutTemplate className="size-3.5" aria-hidden />
                {t('bots.new.fromTemplate', 'Start from a template')}
              </button>
            ) : null}
            <BotCreateButton
              type="submit"
              className="ml-auto"
              busy={creating}
              disabled={!canCreate}
            >
              {t('bots.new.createBot', 'Create bot')}
            </BotCreateButton>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
