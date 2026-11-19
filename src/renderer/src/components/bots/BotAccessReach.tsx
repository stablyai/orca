import React, { useState } from 'react'
import {
  ChevronDown,
  CircleCheck,
  GitPullRequest,
  Laptop,
  Mail,
  MessageSquare,
  SquarePen,
  UserRound,
  ShieldCheck,
  Undo2
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { updateBot } from '@/lib/bot-catalog'
import {
  NATIVE_CHAT_PERMISSION_MODE_ICONS,
  nativeChatPermissionModeDescription,
  nativeChatPermissionModeLabel
} from '@/components/native-chat/session/options/controls/native-chat-permission-mode-labels'
import { newChatPermissionModeForSettings } from '../../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import type { Bot } from '../../../../shared/bot-types'
import { BOT_ACCESS_COPY, type BotAccessCopyId } from '../../../../shared/bots/bot-access-copy'
import {
  botAccessAdvice,
  botAccessReach,
  botAccessSummary,
  botStartingPermission,
  type BotAccessConnector,
  type BotAccessFix,
  type BotReachLine,
  type BotStartingPermission,
  CONNECTOR_REACH_COPY,
  GOOGLE_REACH_COPY,
  type GoogleReachArea
} from '../../../../shared/bots/bot-access-reach'
import { botAgentLabel, botErrorMessage } from './bot-presentation'
import { setBotGoogle, useBotGoogleReach } from './google/google-connect-client'
import { useTurnOnBotGoogle } from './google/use-turn-on-bot-google'
import { NewBotDialog } from './NewBotDialog'

/** This window is on the computer the bot runs on. */
const HERE = { computer: BOT_ACCESS_COPY.thisComputer }

const copy = (t: Translate, id: BotAccessCopyId, values: Record<string, unknown> = {}): string =>
  t(`bots.access.${id}`, BOT_ACCESS_COPY[id], values)

/** What the desktop reads to word a bot's access: its starting permission and whether Google reaches. */
export function useBotAccessSignals(bot: Bot): {
  permission: BotStartingPermission
  google: GoogleReachArea[]
  /** Google is on but its status isn't known yet, so it may reach anything. */
  googleUnknown: boolean
} {
  const appDefault = useAppStore((state) =>
    newChatPermissionModeForSettings(bot.agent, state.settings)
  )
  const { areas, unknown } = useBotGoogleReach(bot)
  return {
    permission: botStartingPermission(bot, appDefault ?? null),
    google: areas,
    googleUnknown: unknown
  }
}

/** "You and Bob can ask CoS.", then what that lets them do. */
export function BotAccessSummary({
  bot,
  others
}: {
  bot: Bot
  others: readonly string[]
}): React.JSX.Element {
  const t = useTranslate()
  const { who, control } = botAccessSummary(others)
  return (
    <div className="mb-2 space-y-0.5">
      <p className="text-sm font-medium">{copy(t, who.id, { ...who.values, name: bot.name })}</p>
      <p className="text-xs leading-5 text-muted-foreground">
        {copy(t, control.id, { ...control.values, name: bot.name, ...HERE })}
      </p>
    </div>
  )
}

/** What the people added can do with the bot, alone: shown only once someone besides the owner is. */
export function BotAccessControlLine({
  bot,
  others,
  className
}: {
  bot: Bot
  others: readonly string[]
  className?: string
}): React.JSX.Element | null {
  const t = useTranslate()
  if (others.length === 0) {
    return null
  }
  const { control } = botAccessSummary(others)
  return (
    <p className={className}>
      {copy(t, control.id, { ...control.values, name: bot.name, ...HERE })}
    </p>
  )
}

function permissionWords(
  t: Translate,
  bot: Bot,
  line: Extract<BotReachLine, { kind: 'permission' }>
): { title: string; detail: string; Icon: React.ElementType } {
  const { mode, fellBackFrom } = line.permission
  const notes = line.notes.map((id) =>
    copy(t, id, {
      name: bot.name,
      agent: botAgentLabel(bot.agent),
      mode: fellBackFrom ? nativeChatPermissionModeLabel(fellBackFrom, t) : ''
    })
  )
  if (!mode) {
    return { title: copy(t, 'reachPermissionUnknown'), detail: notes.join(' '), Icon: ShieldCheck }
  }
  return {
    title: copy(t, 'reachPermission', { mode: nativeChatPermissionModeLabel(mode, t) }),
    detail: [`${nativeChatPermissionModeDescription(mode, bot.agent, t)}.`, ...notes].join(' '),
    Icon: NATIVE_CHAT_PERMISSION_MODE_ICONS[mode]
  }
}

const CONNECTOR_ICON: Record<BotAccessConnector, React.ElementType> = {
  linear: SquarePen,
  slack: MessageSquare,
  github: GitPullRequest
}

function reachWords(
  t: Translate,
  bot: Bot,
  line: BotReachLine
): { title: string; detail?: string; Icon: React.ElementType } {
  switch (line.kind) {
    case 'computer':
      return {
        title: copy(t, 'reachComputer', HERE),
        detail: copy(t, 'reachComputerDetail'),
        Icon: Laptop
      }
    case 'permission':
      return permissionWords(t, bot, line)
    case 'connector':
      return {
        title: copy(t, CONNECTOR_REACH_COPY[line.connector], { name: bot.name }),
        Icon: CONNECTOR_ICON[line.connector]
      }
    case 'google':
      return { title: copy(t, GOOGLE_REACH_COPY[line.area ?? 'unknown']), Icon: Mail }
  }
}

/** What anyone who can ask the bot reaches through it, one line each. */
export function BotAccessReachList({
  bot,
  connector,
  className
}: {
  bot: Bot
  connector: BotAccessConnector | null
  className?: string
}): React.JSX.Element {
  const t = useTranslate()
  const { permission, google } = useBotAccessSignals(bot)
  const lines = botAccessReach({ agent: bot.agent, permission, connector, google })
  return (
    <ul className={className ?? 'space-y-2.5 text-sm'}>
      {lines.map((line) => {
        const { title, detail, Icon } = reachWords(t, bot, line)
        return (
          <li
            key={line.kind === 'google' ? `google:${line.area}` : line.kind}
            className="flex gap-2.5"
          >
            <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0">
              {title}
              {detail ? (
                <span className="block text-xs leading-5 text-muted-foreground">{detail}</span>
              ) : null}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

type Applied = { fix: Exclude<BotAccessFix, 'only-me'>; undo: () => Promise<unknown> }

/** Before you share: the fixes for an open setup, Keep only me first; each applies at once. */
function BotAccessAdvice({
  bot,
  fixes,
  open,
  onKeepOnlyMe
}: {
  bot: Bot
  fixes: readonly BotAccessFix[]
  open: boolean
  onKeepOnlyMe: () => void
}): React.JSX.Element | null {
  const t = useTranslate()
  const [applied, setApplied] = useState<Applied[]>([])
  const [newBotOpen, setNewBotOpen] = useState(false)
  const turnOnGoogle = useTurnOnBotGoogle()
  const [busy, setBusy] = useState(false)
  // One fix at a time, so a double click can't apply it twice.
  const run = <T,>(work: () => Promise<T>, then?: (result: T) => void): void => {
    setBusy(true)
    void work()
      .then(then)
      .catch((error: unknown) => toast.error(botErrorMessage(error)))
      .finally(() => setBusy(false))
  }
  const apply = (fix: BotAccessFix): void => {
    if (fix === 'only-me') {
      onKeepOnlyMe()
      return
    }
    if (fix === 'google-off') {
      run(
        () => setBotGoogle(bot, false),
        () => setApplied((all) => [...all, { fix, undo: () => turnOnGoogle(bot) }])
      )
      return
    }
    const before = bot.permissionMode ?? null
    run(
      () => updateBot(bot, { permissionMode: 'ask' }),
      () =>
        setApplied((all) => [
          ...all,
          { fix, undo: () => updateBot(bot, { permissionMode: before }) }
        ])
    )
  }
  // Turning Google back on asks again when others can ask; a cancel keeps it off.
  const undo = (entry: Applied): void =>
    run(entry.undo, (result) => {
      if (result !== false) {
        setApplied((all) => all.filter((other) => other !== entry))
      }
    })
  const shown = fixes.filter((fix) => !applied.some((entry) => entry.fix === fix))
  if (shown.length === 0 && applied.length === 0) {
    return null
  }
  const rows: Record<
    BotAccessFix,
    { title: string; detail: string; action: string; Icon: React.ElementType }
  > = {
    'only-me': {
      title: copy(t, 'fixOnlyMe', { name: bot.name }),
      detail: copy(t, 'fixOnlyMeDetail'),
      action: copy(t, 'fixOnlyMeAction'),
      Icon: UserRound
    },
    'google-off': {
      title: copy(t, 'fixGoogle', { name: bot.name }),
      detail: copy(t, 'fixGoogleDetail'),
      action: copy(t, 'fixGoogleAction'),
      Icon: Mail
    },
    'ask-for-approval': {
      title: copy(t, 'fixAsk'),
      detail: copy(t, bot.agent === 'codex' ? 'fixAskDetailCodex' : 'fixAskDetail', {
        name: bot.name
      }),
      action: copy(t, 'fixAskAction'),
      Icon: NATIVE_CHAT_PERMISSION_MODE_ICONS.ask
    }
  }
  return (
    <section
      aria-label={copy(t, 'adviceHeading')}
      className="mt-3 space-y-2.5 rounded-lg border border-border p-3"
    >
      <p className="text-2xs font-semibold text-muted-foreground">{copy(t, 'adviceHeading')}</p>
      {applied.map((entry) => (
        <div key={entry.fix} role="status" className="flex items-center gap-2.5 text-sm">
          <CircleCheck className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1">
            {copy(t, entry.fix === 'google-off' ? 'fixGoogleDone' : 'fixAskDone', {
              name: bot.name
            })}
          </span>
          <Button size="xs" variant="ghost" disabled={busy} onClick={() => undo(entry)}>
            <Undo2 />
            {copy(t, 'undo')}
          </Button>
        </div>
      ))}
      {shown.map((fix) => {
        const row = rows[fix]
        return (
          <div key={fix} className="flex items-start gap-2.5 text-sm">
            <row.Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0 flex-1">
              {row.title}
              <span className="block text-xs leading-5 text-muted-foreground">{row.detail}</span>
            </span>
            <Button size="xs" variant="outline" disabled={busy} onClick={() => apply(fix)}>
              {row.action}
            </Button>
          </div>
        )
      })}
      {open ? (
        <p className="text-xs leading-5 text-muted-foreground">
          {copy(t, 'separateBot', HERE)}{' '}
          <Button variant="link" size="inlineText" onClick={() => setNewBotOpen(true)}>
            {copy(t, 'newBot')}
          </Button>
        </p>
      ) : null}
      {newBotOpen ? <NewBotDialog open onOpenChange={setNewBotOpen} /> : null}
    </section>
  )
}

/** The summary's follow-on: advice for an open setup, then what anyone who can ask reaches. */
export function BotAccessDetails({
  bot,
  others,
  connector,
  onKeepOnlyMe
}: {
  bot: Bot
  others: number
  connector: BotAccessConnector
  onKeepOnlyMe: () => void
}): React.JSX.Element | null {
  const t = useTranslate()
  const { permission, google } = useBotAccessSignals(bot)
  const advice = botAccessAdvice({ others, permission, google: google.length > 0 })
  const [reachOpen, setReachOpen] = useState(true)
  if (others === 0) {
    return null
  }
  return (
    <>
      <BotAccessAdvice
        bot={bot}
        fixes={advice.fixes}
        open={advice.open}
        onKeepOnlyMe={onKeepOnlyMe}
      />
      <div className="mt-3 rounded-lg border border-border px-3 pb-3 pt-1">
        <Collapsible open={reachOpen} onOpenChange={setReachOpen}>
          <CollapsibleTrigger variant="row">
            {copy(t, 'reachHeading', { name: bot.name })}
            <ChevronDown
              className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180"
              aria-hidden
            />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <BotAccessReachList
              bot={bot}
              connector={connector}
              className="space-y-2.5 pt-1 text-sm"
            />
          </CollapsibleContent>
        </Collapsible>
        {advice.open ? null : (
          <p className="mt-2.5 flex items-center gap-2 text-xs text-muted-foreground">
            <ShieldCheck className="size-3.5 shrink-0" aria-hidden />
            {copy(t, 'trust')}
          </p>
        )}
      </div>
    </>
  )
}
