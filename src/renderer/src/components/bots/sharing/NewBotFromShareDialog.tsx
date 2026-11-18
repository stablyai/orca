// New bot, from a reviewed link: the New bot dialog's picture, name and agent, plus the per-bot
// permission (Ask, picked for bots made from a link) and the review's tool ticks. Create writes the
// reviewed version whole, or nothing.
import { ownBotHost } from '@/lib/bot-hosts'
import { useId, useRef, useState } from 'react'
import { Check, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useTranslate } from '@/i18n/use-translate'
import { createBot, useHostBots } from '@/lib/bot-catalog'
import { BOT_NAME_MAX_LENGTH, type Bot } from '../../../../../shared/bot-types'
import {
  BOT_SHARE_RECEIVE_ERRORS,
  type BotShareReview
} from '../../../../../shared/bots/bot-share-received'
import { openCreatedBot } from '../bot-create-open'
import { botShareErrorMessage } from './bot-share-error-copy'
import { BotPicturePicker } from '../BotPicturePicker'
import { BotRunsOnPicker } from '../BotRunsOnPicker'
import { useBotAgentMenu } from '../use-bot-agent-choices'
import { useBotCreateHost } from '../bot-create-hosts'
import { reviewBotShare } from './bot-share-rpc'
import { useBotAgentSetup } from '../use-bot-agent-setup'
import { useNewBotPicture } from '../use-new-bot-picture'
import { toolHost } from './bot-share-review-parts'
import { Tick } from './BotShareTick'

const RECEIVE_CODES = ['updated', 'stopped', 'expired'] as const
export type BotShareMoved = (typeof RECEIVE_CODES)[number]

type SharedBotPermission = 'ask' | 'full-access' | 'chats'

/** The shared name, or "Name 2", "Name 3"… when a bot here has it. */
function freeBotName(name: string, bots: readonly Bot[]): string {
  const taken = new Set(bots.map((bot) => bot.name.toLowerCase()))
  if (!taken.has(name.toLowerCase())) {
    return name
  }
  for (let n = 2; ; n += 1) {
    const candidate = `${name.slice(0, BOT_NAME_MAX_LENGTH - ` ${n}`.length)} ${n}`
    if (!taken.has(candidate.toLowerCase())) {
      return candidate
    }
  }
}

function PermissionLine({
  value,
  onChange
}: {
  value: SharedBotPermission
  onChange: (value: SharedBotPermission) => void
}): React.JSX.Element {
  const t = useTranslate()
  const options: { id: SharedBotPermission; title: string; detail: string }[] = [
    {
      id: 'ask',
      title: t('bots.share.receive.ask', 'Ask for approval'),
      detail: t('bots.share.receive.askDetail', 'Picked for bots made from a link')
    },
    {
      id: 'full-access',
      title: t('bots.share.receive.full', 'Full access'),
      detail: t('bots.share.receive.fullDetail', 'Runs commands without asking')
    },
    {
      id: 'chats',
      title: t('settings.bots.permissionSameAsChats', 'Same as chats'),
      detail: t('bots.share.receive.chatsDetail', 'Starts from your chat permission setting')
    }
  ]
  const line =
    value === 'ask'
      ? t(
          'bots.share.receive.askLine',
          'Asks before running commands. Your own allow rules still apply.'
        )
      : value === 'full-access'
        ? t('bots.share.receive.fullLine', 'Runs commands without asking.')
        : t('bots.share.receive.chatsLine', 'Asks as your chats do.')
  return (
    <div className="flex gap-2 text-sm">
      <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <div>
        {line}{' '}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="link" size="inlineText">
              {t('bots.share.receive.change', '(Change)')}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            {options.map((option) => (
              <DropdownMenuItem key={option.id} onSelect={() => onChange(option.id)}>
                <Check className={value === option.id ? 'size-3.5' : 'invisible size-3.5'} />
                <div>
                  <div>{option.title}</div>
                  <div className="text-xs text-muted-foreground">{option.detail}</div>
                </div>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}

export function NewBotFromShareDialog({
  review,
  toolIds,
  onToolIdsChange,
  onBack,
  onMoved,
  onClose
}: {
  review: BotShareReview
  toolIds: string[]
  onToolIdsChange: (ids: string[]) => void
  onBack: () => void
  /** The link moved or stopped since the review, or the review expired: back to it. */
  onMoved: (why: BotShareMoved) => void
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const nameId = useId()
  const hostChoice = useBotCreateHost(true)
  const { hostId, blocked } = hostChoice.host
  const bots = useHostBots(hostId)
  // Free on the picked computer, until the owner types one.
  const [typedName, setName] = useState<string | null>(null)
  const name = typedName ?? freeBotName(review.bot.name, bots)
  const [permission, setPermission] = useState<SharedBotPermission>('ask')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const openedBot = useRef(false)
  const menu = useBotAgentMenu(hostId, true)
  const agentSetup = useBotAgentSetup(menu.choices, hostId)
  const sharedPng = review.avatarDataUrl?.slice(review.avatarDataUrl.indexOf(',') + 1)
  const sharedMascot =
    review.bot.avatar && 'mascot' in review.bot.avatar ? review.bot.avatar.mascot : undefined
  const picture = useNewBotPicture(sharedMascot, sharedPng)
  const trimmedName = name.trim()

  const create = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (!trimmedName || creating || blocked) {
      return
    }
    setCreating(true)
    setError(null)
    const { permissionMode: _picked, ...setup } = agentSetup.setup
    // The shared picture is written by Create itself; another upload is saved after, as New bot does.
    const keepsShared = sharedPng !== undefined && picture.shownUpload === sharedPng
    let bot: Bot
    try {
      // The review shown was read here; another computer reads the same version for itself.
      const reviewId =
        hostId === ownBotHost().hostId
          ? review.reviewId
          : (await reviewBotShare(review.shareId, review.versionId, hostId))?.reviewId
      if (!reviewId) {
        setCreating(false)
        onMoved('expired')
        return
      }
      bot = await createBot(hostId, {
        name: trimmedName,
        ...setup,
        ...(permission === 'chats' ? {} : { permissionMode: permission }),
        ...(keepsShared ? {} : { avatar: picture.avatar }),
        fromShare: { reviewId, toolIds }
      })
      bot = keepsShared ? bot : await picture.saveUpload(bot)
    } catch (cause) {
      setCreating(false)
      const message = cause instanceof Error ? cause.message : ''
      const moved = RECEIVE_CODES.find((code) => message.includes(BOT_SHARE_RECEIVE_ERRORS[code]))
      if (moved) {
        onMoved(moved)
        return
      }
      setError(botShareErrorMessage(cause))
      return
    }
    const opened = await openCreatedBot(bot)
    openedBot.current = opened
    setCreating(false)
    onClose()
  }

  return (
    <Dialog open onOpenChange={(next) => !next && !creating && onClose()}>
      <DialogContent
        // Running a stranger's instructions, and with what permission: a plugin theme never restyles it.
        surface="security"
        className="max-w-md sm:max-w-md"
        onCloseAutoFocus={(event) => {
          // The new bot's composer has focus by then.
          if (openedBot.current) {
            event.preventDefault()
          }
        }}
      >
        <DialogHeader className="sm:text-center">
          <DialogTitle>{t('bots.new.title', 'New bot')}</DialogTitle>
          <DialogDescription>
            {review.publisher
              ? t('bots.share.receive.origin', "From {{who}}'s link", { who: review.publisher })
              : t('bots.share.receive.originAnonymous', 'From a shared link')}
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={(event) => void create(event)}>
          <BotPicturePicker
            value={picture.value}
            custom={picture.custom}
            onChange={picture.onChange}
            onUpload={picture.onUpload}
          />
          <div>
            <Label htmlFor={nameId} className="sr-only">
              {t('bots.new.name', 'Name')}
            </Label>
            <Input
              id={nameId}
              variant="heading"
              autoFocus
              autoComplete="off"
              spellCheck={false}
              value={name}
              maxLength={BOT_NAME_MAX_LENGTH}
              placeholder={t('bots.new.namePlaceholder', 'Name your bot')}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <BotRunsOnPicker
            hostChoice={hostChoice}
            setup={agentSetup.setup}
            model={menu.model}
            choices={menu.choices}
            onSetupChange={agentSetup.setSetup}
            name={name}
          />
          <PermissionLine value={permission} onChange={setPermission} />
          {review.bot.tools.map((tool) => {
            const label = t('bots.share.review.contact', 'Let it contact {{host}}', {
              host: toolHost(tool.url)
            })
            return (
              <div key={tool.id} className="flex gap-2 text-sm">
                <Tick
                  checked={toolIds.includes(tool.id)}
                  label={label}
                  onChange={(on) =>
                    onToolIdsChange(
                      on ? [...toolIds, tool.id] : toolIds.filter((id) => id !== tool.id)
                    )
                  }
                />
                <div className="min-w-0">
                  <div className="truncate">{label}</div>
                  <div className="truncate text-xs text-muted-foreground">{tool.name}</div>
                </div>
              </div>
            )
          })}
          <DialogFooter className="items-center">
            {error ? (
              <span className="mr-auto text-xs text-destructive" role="alert">
                {error}
              </span>
            ) : null}
            <Button type="button" variant="outline" size="sm" disabled={creating} onClick={onBack}>
              {t('bots.share.receive.back', 'Back')}
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={!trimmedName || creating || Boolean(blocked) || menu.choices.length === 0}
            >
              {creating ? t('bots.new.creating', 'Creating…') : t('bots.new.create', 'Create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
