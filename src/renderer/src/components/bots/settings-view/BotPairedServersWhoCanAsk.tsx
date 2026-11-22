// Who can ask the bot from paired servers without a card each time: servers this computer always
// allows, each removable, and a + that picks another from the paired servers that can ask.
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { Info, Plus, Server } from 'lucide-react'
import { toast } from 'sonner'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { useTranslate } from '@/i18n/use-translate'
import { callBotRpc } from '@/lib/bot-hosts'
import { onBotsChanged } from '@/lib/bots-changed-window-event'
import { readBotHostIds, subscribeToBotChanges } from '@/lib/bot-catalog-snapshot'
import { runtimeEnvironmentSupportsCapability } from '@/runtime/rpc/compatibility/runtime-capability-proof'
import type { Bot } from '../../../../../shared/bot-types'
import { toRuntimeExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { ORCHESTRATION_CLIENT_AGENT_ASKS_RUNTIME_CAPABILITY } from '../../../../../shared/orchestration/orchestration-runtime-capabilities'
import { botMentionServer } from '../bot-mention-server'
import { useBotHostLabels } from '../use-bot-host-label'

const Allowances = z.object({
  servers: z.array(z.object({ serverKey: z.string(), environmentId: z.string() }))
})
type Allowance = z.infer<typeof Allowances>['servers'][number]

/** The servers always allowed to ask `bot`, read from its host; reread after each change here. */
function useAllowances(bot: Bot): { servers: Allowance[] | null; reread: () => void } {
  const [servers, setServers] = useState<Allowance[] | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    callBotRpc(bot, 'pairedServerAsks.allowances', { botId: bot.id })
      .then((read) => {
        if (live) {
          setServers(Allowances.parse(read).servers)
        }
      })
      // A host without paired-server asks has none.
      .catch(() => (live ? setServers([]) : undefined))
    return () => {
      live = false
    }
  }, [bot, attempt])
  const reread = useCallback(() => setAttempt((count) => count + 1), [])
  // An Always allow on a card, or a removed pairing, changes the list from elsewhere.
  useEffect(
    () => onBotsChanged(reread, bot.hostId, { botId: bot.id, kinds: ['chats'] }),
    [bot.hostId, bot.id, reread]
  )
  return { servers, reread }
}

/** Paired servers whose agents can message agents here, by environment id. */
function useAskingServers(): string[] {
  const hostIds = useSyncExternalStore(subscribeToBotChanges, readBotHostIds, readBotHostIds)
  const key = hostIds.flatMap((hostId) => botMentionServer(hostId) ?? []).join('\n')
  const [capable, setCapable] = useState<{ key: string; ids: string[] }>({ key: '', ids: [] })
  useEffect(() => {
    const ids = key ? key.split('\n') : []
    let live = true
    void Promise.all(
      ids.map((id) =>
        runtimeEnvironmentSupportsCapability(id, ORCHESTRATION_CLIENT_AGENT_ASKS_RUNTIME_CAPABILITY)
          .then((supported) => (supported ? id : null))
          .catch(() => null)
      )
    ).then((found) => {
      if (live) {
        setCapable({ key, ids: found.filter((id): id is string => id !== null) })
      }
    })
    return () => {
      live = false
    }
  }, [key])
  return capable.key === key ? capable.ids : []
}

export function BotPairedServersWhoCanAsk({ bot }: { bot: Bot }): React.JSX.Element {
  const t = useTranslate()
  const { servers, reread } = useAllowances(bot)
  const asking = useAskingServers()
  const [pickerOpen, setPickerOpen] = useState(false)
  const allowedEnvironments = new Set((servers ?? []).map((server) => server.environmentId))
  const addable = asking.filter((id) => !allowedEnvironments.has(id))
  const labels = useBotHostLabels(
    [...(servers ?? []).map((server) => server.environmentId), ...asking].map((id) =>
      toRuntimeExecutionHostId(id)
    )
  )
  const nameOf = (environmentId: string): string =>
    labels.get(toRuntimeExecutionHostId(environmentId)) || environmentId
  const change = (method: string, params: Record<string, string>): void => {
    callBotRpc(bot, method, { botId: bot.id, ...params })
      .catch((error: unknown) =>
        toast.error(error instanceof Error ? error.message : String(error))
      )
      .finally(reread)
  }
  return (
    <section className="flex min-w-0 flex-col gap-2" aria-labelledby={`paired-servers-${bot.id}`}>
      <h3 className="flex items-center gap-2 px-1 text-xs font-medium text-muted-foreground">
        <Server className="size-3.5 shrink-0" aria-hidden />
        <span id={`paired-servers-${bot.id}`}>
          {t('bots.pairedServers.heading', 'Paired servers')}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground"
              aria-label={t('bots.pairedServers.info', 'About paired servers')}
            >
              <Info className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>
            {t(
              'bots.pairedServers.tooltip',
              'Bots and agents on these servers can ask {{name}} without asking you each time.',
              { name: bot.name }
            )}
          </TooltipContent>
        </Tooltip>
        <span className="flex-1" />
        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
          <PopoverTrigger asChild>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={t('bots.pairedServers.add', 'Add a paired server')}
            >
              <Plus />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80">
            <Command>
              <CommandInput
                autoFocus
                placeholder={t('bots.pairedServers.search', 'Search paired servers')}
              />
              <CommandList>
                <CommandEmpty>
                  {asking.length === 0
                    ? t('bots.pairedServers.none', 'No paired servers')
                    : t('bots.pairedServers.allAdded', 'Every paired server is added')}
                </CommandEmpty>
                {addable.length > 0 ? (
                  <CommandGroup heading={t('bots.pairedServers.heading', 'Paired servers')}>
                    {addable.map((environmentId) => (
                      <CommandItem
                        key={environmentId}
                        value={nameOf(environmentId)}
                        onSelect={() => {
                          setPickerOpen(false)
                          change('pairedServerAsks.allow', { environmentId })
                        }}
                      >
                        <Server className="size-4 shrink-0" />
                        <span className="min-w-0 flex-1 truncate">{nameOf(environmentId)}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                ) : null}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </h3>
      {servers && servers.length > 0 ? (
        <ul className="rounded-[10px] bg-foreground/[0.035] p-1">
          {servers.map((server) => (
            <li
              key={server.serverKey}
              className="group flex min-h-8 items-center gap-2 rounded-md px-2 text-sm"
            >
              <Server className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{nameOf(server.environmentId)}</span>
              {/* Shown only while the row is hovered or focused. */}
              <span className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
                <Button
                  size="xs"
                  variant="link-muted"
                  aria-label={t('bots.pairedServers.removeServer', 'Remove {{server}}', {
                    server: nameOf(server.environmentId)
                  })}
                  onClick={() =>
                    change('pairedServerAsks.disallow', {
                      serverKey: server.serverKey
                    })
                  }
                >
                  {t('bots.pairedServers.remove', 'Remove')}
                </Button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
