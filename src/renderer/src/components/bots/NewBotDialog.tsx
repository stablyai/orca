// @protected-copy scope=file
// Its copy is fixed: a bot from someone else's link is made here, on the security surface.
import React, { useId, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { toast } from 'sonner'
import { LayoutTemplate } from 'lucide-react'
import {
  AddRemoteHostDialog,
  type AddRemoteHostMode
} from '@/components/sidebar/host-admission/ssh/AddRemoteHostDialog'
import { useAppStore } from '@/store'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { ImeInput } from '@/lib/text-input/ime/ime-text-field'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { createBot, useHostBots } from '@/lib/bot-catalog'
import { handleScreenFormSubmitKey } from '@/lib/keyboard/screen-submit-shortcut'
import { BOT_NAME_MAX_LENGTH, type Bot, type BotAgent } from '../../../../shared/bot-types'
import { botCreateErrorMessage } from './bot-presentation'
import { BotRunsOnPicker } from './BotRunsOnPicker'
import { BotImportNudge } from './BotImportNudge'
import { openCreatedBot } from './bot-create-open'
import { NewBotPictureButton } from './NewBotPictureButton'
import { useNewBotHostLooks, useNewBotPicture } from './use-new-bot-picture'
import { followedByPicture, useNewBotDialogPicture } from './use-new-bot-generate-face'
import { useBotAgentMenu } from './use-bot-agent-choices'
import { useBotCreateHost } from './bot-create-hosts'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import { useBotAgentSetup } from './use-bot-agent-setup'
import { proposalCreateParams, type BotProposal } from '../../../../shared/bots/bot-proposal'
import { BOTS_TEMPLATES_RUNTIME_CAPABILITY } from '../../../../shared/bot-runtime-capabilities'
import { useBotHostHas } from '@/lib/bot-host-status'
import { Button } from '@/components/ui/button'
import { DEFAULT_BOT_AVATAR_COLOR } from '../../../../shared/bots/bot-avatar-color'
import { botTemplate, type BotTemplateSkill } from '../../../../shared/bots/bot-templates'
import { botTemplateWord } from '../../../../shared/bots/bot-template-text'
import { NewBotTemplateParts } from './NewBotTemplateParts'
import type { BotCreateParams } from '../../../../shared/rpc-contract/bots-params'
import { NewBotProposalFields, NewBotTakesOver } from './NewBotProposalFields'
import { NewBotPurposeField } from './NewBotPurposeField'
import { BotCreateButton } from './BotCreateButton'
import { BARE_HEADING_CLASS, FIELD_ERROR, keyboardNavMarkerHandlers } from './new-bot-bare-fields'
import { openBotTemplates } from './templates/bot-templates-open'
import { pictureTintFor } from './avatar-picture-tint'
import {
  canonicalDraft,
  draftOf,
  editedProposal,
  identityTooLong,
  shownDraft,
  shownTemplateIdentity
} from './new-bot-draft'
import { botShareErrorMessage } from './sharing/bot-share-error-copy'
import {
  createNewBotFromShare,
  freeBotName,
  sharedLook,
  sharedMascot,
  sharedPicturePng,
  type NewBotShareSource
} from './sharing/new-bot-from-share'
import { NewBotShareBack, useShareOrigin } from './sharing/NewBotFromShareParts'

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
  offerHostId,
  fromShare
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
  /** Made from a reviewed link, said in place of the description: its picture first, Ask picked first,
   *  and Back returns to the review.
   *  Create writes the reviewed bot, so there is no purpose to type. */
  fromShare?: NewBotShareSource
}): React.JSX.Element {
  const t = useTranslate()
  const nameErrorId = useId()
  const nameRef = useRef<HTMLInputElement>(null)
  const formRef = useRef<HTMLFormElement>(null)
  // A link's name is only suggested until the owner types one: free on the picked computer.
  const [typedName, setName] = useState<string | null>(
    fromShare ? null : (proposal?.name ?? initialName ?? '')
  )
  const [addHostMode, setAddHostMode] = useState<AddRemoteHostMode | null>(null)
  const [draft, setDraft] = useState(() => draftOf(proposal, initialPurpose))
  const shown = shownDraft(proposal, draft, t)
  const keepDraft = (next: typeof draft): void => setDraft(canonicalDraft(proposal, next, t))
  const hostChoice = useBotCreateHost(open, hosts, offerHostId)
  const { hostId, blocked, label } = hostChoice.host
  const hostBots = useHostBots(hostId)
  const name = typedName ?? (fromShare ? freeBotName(fromShare.review.bot.name, hostBots) : '')
  const { model, choices } = useBotAgentMenu(hostId, open)
  // A bot from someone else's link starts on Ask, whatever the owner's chats do.
  const agentSetup = useBotAgentSetup(choices, hostId, initialAgent, fromShare && 'ask')
  const [creating, setCreating] = useState(false)
  const createInFlight = useRef(false)
  const [submitted, setSubmitted] = useState(false)
  const trimmedName = name.trim()
  const createdBot = useRef(false)
  const picture = useNewBotPicture(
    useNewBotHostLooks(hostId),
    fromShare ? sharedMascot(fromShare.review) : proposal?.mascot,
    fromShare && sharedPicturePng(fromShare.review),
    fromShare && sharedLook(fromShare.review)
  )
  const { intake, face } = useNewBotDialogPicture(picture, creating)
  const shownIdentity = shownTemplateIdentity(proposal, t)
  const purposeTooLong = identityTooLong(proposal, draft, t)
  const nameInvalid = submitted && !trimmedName
  // From Bot templates itself (Blank bot), the row would only lead back to it.
  const fromTemplates = useAppStore((state) => state.activeModal === 'bot-templates')
  // From a template: what it comes with, its skills kept unless switched off; an older host takes the seed only.
  const template = botTemplate(proposal?.templateId)
  const templatePackages = useBotHostHas(hostId, BOTS_TEMPLATES_RUNTIME_CAPABILITY)
  const [kept, setKept] = useState<ReadonlySet<BotTemplateSkill>>(
    () => new Set(template?.skills ?? [])
  )

  const close = (made?: Bot): void => {
    setSubmitted(false)
    setName(fromShare ? null : (proposal?.name ?? ''))
    setAddHostMode(null)
    setDraft(draftOf(proposal, initialPurpose))
    agentSetup.reset()
    picture.reset()
    intake.dismiss()
    // A run handed to the bot made goes on; any other ends here.
    face.reset()
    hostChoice.reset()
    onOpenChange(false, made)
  }
  const handleOpenChange = (next: boolean): void => {
    if (createInFlight.current) {
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
    if (createInFlight.current) {
      return
    }
    if (!trimmedName || purposeTooLong || blocked || !choices.length || intake.reading) {
      flushSync(() => setSubmitted(true))
      formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
      return
    }
    createInFlight.current = true
    setCreating(true)
    const follow = followedByPicture(face, { hostId, name: trimmedName })
    const made = fromShare ? null : editedProposal(proposal, draft, trimmedName, t)
    let bot: Bot | null
    try {
      if (fromShare) {
        const { setup, intent } = agentSetup
        bot = await follow(
          createNewBotFromShare(fromShare, hostId, { name: trimmedName, setup, intent }, picture)
        )
      } else {
        const offerHere = hostId === (offerHostId ?? LOCAL_EXECUTION_HOST_ID)
        bot = await follow(
          createBot(hostId, {
            ...(made
              ? proposalCreateParams(
                  offerHere ? made : { ...made, worktrees: undefined },
                  agentSetup.setup.agent,
                  {
                    templatePackages,
                    skills: [...kept],
                    templateNameShown: template ? botTemplateWord(template, 'name', t) : undefined,
                    fromOffer: offerHere ? fromOffer : undefined
                  }
                )
              : { name: trimmedName }),
            ...agentSetup.setup,
            avatar: picture.avatar,
            avatarColor: picture.avatarColor,
            avatarOutfit: picture.avatarOutfit,
            ...(takingOver ? { takingOver } : {})
          }).then(picture.saveUpload)
        )
      }
    } catch (error) {
      createInFlight.current = false
      setCreating(false)
      toast.error(
        fromShare ? botShareErrorMessage(error) : botCreateErrorMessage(error, made?.purpose, label)
      )
      return
    }
    createInFlight.current = false
    setCreating(false)
    if (!bot) {
      return
    }
    // Closes once the bot exists, as a new workspace's composer does; its page opens next and shows
    // its agent starting.
    createdBot.current = true
    close(bot)
    void openCreatedBot(bot).then((opened) => {
      if (opened || takingOver) {
        onCreated?.(bot)
      }
    })
  }

  const shownOrigin = useShareOrigin(fromShare) ?? origin
  const pictureButton = { picture, intake, submitted, generate: face, disabled: creating }
  const showTemplateLink = !proposal && !fromShare && !fromTemplates && !name && !draft.purpose
  // A mascot's band is its tile color; a picture's is its background's, read when it was taken in.
  const band = picture.shownUpload
    ? pictureTintFor(picture.shownUpload)
    : (picture.color ?? DEFAULT_BOT_AVATAR_COLOR)
  const bandStyle: React.CSSProperties & { '--new-bot-band': string } = {
    '--new-bot-band': band ?? DEFAULT_BOT_AVATAR_COLOR
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        size="form"
        // Running someone else's instructions: a plugin theme never restyles it.
        surface={fromShare ? 'security' : undefined}
        showCloseButton
        className={cn(
          'max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] grid-rows-[auto_minmax(0,1fr)] overflow-hidden',
          proposal && !template && 'max-w-xl sm:max-w-xl'
        )}
        // Only a proposal's origin describes it; without one there is no description to point at.
        {...(shownOrigin ? {} : { 'aria-describedby': undefined })}
        {...keyboardNavMarkerHandlers}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          // A template's or a link's name is already set: focus stays off it, so a long one shows its
          // start with "…"; ⌘↩ still creates. Otherwise the name, not Radix's first tabbable, so typing
          // names the bot.
          if (template || fromShare) {
            formRef.current?.focus()
          } else {
            nameRef.current?.focus()
          }
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
        {/* A soft band of the picture's colour behind the top of the dialog; none for a picture whose
            edge is transparent. */}
        {band === null ? null : (
          <div
            aria-hidden
            style={bandStyle}
            className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[84px] bg-[linear-gradient(180deg,color-mix(in_srgb,var(--new-bot-band)_46%,transparent),transparent)] dark:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--new-bot-band)_26%,transparent),transparent)]"
          />
        )}
        <DialogHeader>
          <DialogTitle>{t('bots.new.title', 'New bot')}</DialogTitle>
          {shownOrigin ? <DialogDescription>{shownOrigin}</DialogDescription> : null}
        </DialogHeader>
        <form
          ref={formRef}
          tabIndex={-1}
          className="flex min-h-0 flex-col gap-4 outline-none"
          onSubmit={(event) => void handleSubmit(event)}
          onKeyDown={handleScreenFormSubmitKey}
        >
          <div className="-mx-5 -mt-1 min-h-0 space-y-4 overflow-x-hidden overflow-y-auto px-5 pt-1 scrollbar-sleek">
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
            <div className="space-y-3 pt-1">
              <NewBotPictureButton {...pictureButton}>
                <ImeInput
                  ref={nameRef}
                  className={cn(
                    BARE_HEADING_CLASS,
                    'aria-invalid:px-2 aria-invalid:ring-1 aria-invalid:ring-destructive aria-invalid:outline-destructive'
                  )}
                  aria-label={t('bots.new.name', 'Name')}
                  aria-invalid={nameInvalid || undefined}
                  aria-describedby={nameInvalid ? nameErrorId : undefined}
                  autoComplete="off"
                  spellCheck={false}
                  value={name}
                  maxLength={BOT_NAME_MAX_LENGTH}
                  placeholder={t('bots.new.name', 'Name')}
                  onChange={(event) => setName(event.target.value)}
                />
                {nameInvalid ? (
                  <p id={nameErrorId} role="alert" className={FIELD_ERROR}>
                    {t('bots.new.validation.addName', 'Add a name')}
                  </p>
                ) : null}
              </NewBotPictureButton>
              {fromShare ? null : (
                <NewBotPurposeField
                  value={shown.purpose}
                  prefilled={shownIdentity}
                  tooLong={submitted && purposeTooLong}
                  sentLength={editedProposal(proposal, draft, trimmedName, t)?.purpose.length ?? 0}
                  onChange={(purpose) => keepDraft({ ...draft, purpose })}
                />
              )}
            </div>
            <BotRunsOnPicker
              variant="fields"
              hostChoice={hostChoice}
              setup={agentSetup.setup}
              model={model}
              choices={choices}
              onSetupChange={agentSetup.setSetup}
              keptPermission={agentSetup.intent}
              onAddHost={hosts ? undefined : setAddHostMode}
              showSubmitFeedback={submitted}
            />
            {template ? <NewBotTakesOver worktrees={proposal?.worktrees} /> : null}
            {template ? (
              <NewBotTemplateParts
                template={template}
                packages={templatePackages}
                hostLabel={submitted && blocked ? undefined : label}
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
            ) : proposal ? (
              <div className="border-t border-border pt-4">
                <NewBotProposalFields
                  draft={shown}
                  worktrees={proposal.worktrees}
                  onChange={(fields) => keepDraft({ ...draft, ...fields })}
                />
              </div>
            ) : null}
          </div>
          <DialogFooter className="mt-0 shrink-0">
            {/* It closes this dialog, so it shows only before anything is typed. */}
            {showTemplateLink ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  close()
                  openBotTemplates()
                }}
              >
                <LayoutTemplate aria-hidden />
                {t('bots.new.fromTemplate', 'Template')}
              </Button>
            ) : null}
            {fromShare ? <NewBotShareBack source={fromShare} disabled={creating} /> : null}
            <BotCreateButton type="submit" busy={creating} disabled={creating}>
              {t('bots.new.create', 'Create')}
            </BotCreateButton>
          </DialogFooter>
        </form>
      </DialogContent>
      {addHostMode ? (
        <AddRemoteHostDialog mode={addHostMode} onOpenChange={setAddHostMode} />
      ) : null}
    </Dialog>
  )
}
