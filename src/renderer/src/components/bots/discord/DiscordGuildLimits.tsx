// A Discord server's limits on its row: the roles whose holders may ask the bot, and the only
// channels it answers in. Both are kept on the bot and sent to Orca Cloud, which checks them.
import React, { useState } from 'react'
import { Hash, Plus, Shield, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useTranslate } from '@/i18n/use-translate'
import { updateBot } from '@/lib/bot-catalog'
import { botDiscordCalls } from '@/lib/bot-connector-host-calls'
import type { Bot, BotDiscordGuild } from '../../../../../shared/bot-types'
import { BOT_MAX_DISCORD_LIMITS } from '../../../../../shared/bots/bot-discord-guild'
import type { ConnectorBotDiscordGuildResponse } from '../../../../../shared/connector-bot-discord-contract'
import { BotConnectorSection } from '../bot-connector-people'
import { botErrorMessage } from '../bot-presentation'
import { useBotHostLabel } from '../use-bot-host-label'
import { botDiscordErrorMessage } from './bot-discord-copy'

type Named = { id: string; name: string }
type LimitKind = 'roles' | 'channels'

/** Saves one server's limits; the other servers and its people stay as they are. */
async function saveLimits(bot: Bot, guildId: string, kind: LimitKind, next: Named[]) {
  if (!bot.discord) {
    return
  }
  const guilds = bot.discord.guilds.map((guild) =>
    guild.guildId === guildId ? { ...guild, [kind]: next } : guild
  )
  await updateBot(bot, { discord: { applicationId: bot.discord.applicationId, guilds } }).catch(
    (error: unknown) => toast.error(botErrorMessage(error))
  )
}

export function DiscordGuildLimits({
  bot,
  guild
}: {
  bot: Bot
  guild: BotDiscordGuild
}): React.JSX.Element {
  const t = useTranslate()
  const hostName = useBotHostLabel(bot.hostId)
  // The server's roles and channels, read when a picker first opens.
  const [found, setFound] = useState<ConnectorBotDiscordGuildResponse | 'loading' | null>(null)
  const load = async (): Promise<void> => {
    if (found !== null && found !== 'loading') {
      return
    }
    setFound('loading')
    const result = await botDiscordCalls(bot.hostId).guild({
      botId: bot.id,
      guildId: guild.guildId
    })
    if (result.ok) {
      setFound(result.value)
    } else {
      setFound(null)
      toast.error(botDiscordErrorMessage(result.error, hostName))
    }
  }
  const options = (kind: LimitKind): Named[] | null =>
    found === null || found === 'loading' ? null : found[kind]
  return (
    <>
      <LimitList
        title={t('bots.discord.limits.roles', 'Roles that can ask')}
        empty={t('bots.discord.limits.noRoles', 'No roles. Only the people above can ask.')}
        Icon={Shield}
        listed={guild.roles ?? []}
        options={options('roles')}
        onOpen={load}
        onChange={(next) => void saveLimits(bot, guild.guildId, 'roles', next)}
      />
      <LimitList
        title={t('bots.discord.limits.channels', 'Channels it answers in')}
        empty={t(
          'bots.discord.limits.anyChannel',
          'Any channel it can see. Add channels to answer only there.'
        )}
        Icon={Hash}
        listed={guild.channels ?? []}
        options={options('channels')}
        onOpen={load}
        onChange={(next) => void saveLimits(bot, guild.guildId, 'channels', next)}
      />
    </>
  )
}

function LimitList({
  title,
  empty,
  Icon,
  listed,
  options,
  onOpen,
  onChange
}: {
  title: string
  empty: string
  Icon: React.ComponentType<{ className?: string }>
  listed: readonly Named[]
  /** The server's own, once read; null while it is read. */
  options: readonly Named[] | null
  onOpen: () => void
  onChange: (next: Named[]) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const offered = (options ?? []).filter(
    (option) => !listed.some((entry) => entry.id === option.id)
  )
  const full = listed.length >= BOT_MAX_DISCORD_LIMITS
  const add = (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          onOpen()
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="ghost" size="xs" disabled={full}>
          <Plus />
          {t('bots.discord.limits.add', 'Add')}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64">
        <Command>
          <CommandInput placeholder={t('bots.discord.limits.search', 'Search')} />
          <CommandList>
            <CommandEmpty>
              {options === null
                ? t('bots.discord.limits.loading', 'Reading the server…')
                : t('bots.discord.limits.none', 'Nothing more to add.')}
            </CommandEmpty>
            <CommandGroup>
              {offered.map((option) => (
                <CommandItem
                  key={option.id}
                  value={`${option.name} ${option.id}`}
                  onSelect={() => {
                    onChange([...listed, { id: option.id, name: option.name }])
                    setOpen(false)
                  }}
                >
                  <Icon className="size-3.5 text-muted-foreground" />
                  <span className="truncate">{option.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
  return (
    <BotConnectorSection title={title} count={listed.length || undefined} action={add}>
      {listed.length === 0 ? (
        <p className="mb-4 text-xs leading-5 text-muted-foreground">{empty}</p>
      ) : (
        <ul className="mb-4 flex flex-wrap gap-1.5">
          {listed.map((entry) => (
            <li
              key={entry.id}
              className="inline-flex h-7 max-w-60 items-center gap-1 rounded-full border border-border pr-1 pl-2.5 text-xs dark:border-input"
            >
              <Icon className="size-3 shrink-0 text-muted-foreground" />
              <span className="truncate">{entry.name || entry.id}</span>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={t('bots.discord.limits.remove', 'Remove {{name}}', {
                  name: entry.name || entry.id
                })}
                onClick={() => onChange(listed.filter((other) => other.id !== entry.id))}
              >
                <X />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </BotConnectorSection>
  )
}
