// Bot settings › Tools: whether the bot's sessions also take its host's MCP servers (Settings › MCP
// servers), above the tools only it has. Shown only by a host that serves them.
import React, { useState } from 'react'
import { Plug } from 'lucide-react'
import { toast } from 'sonner'
import { Switch } from '@/components/ui/switch'
import { useTranslate } from '@/i18n/use-translate'
import { botTarget, callBotRpc } from '@/lib/bot-hosts'
import { botToolErrorMessage } from '@/components/bots/bot-tools-client'
import { changed } from '@/components/bots/bot-tools-revision'
import { botAgentLabel } from '@/components/bots/bot-presentation'
import type { Bot } from '../../../../../shared/bot-types'
import { useMcpServers, useStableMcpTarget } from '../mcp-servers/use-mcp-servers'
import { mcpServerTitle } from '../mcp-servers/mcp-server-words'

/**
 * The host's servers this bot's agent gets. A server can be off for an agent, so a host whose servers
 * are all off for it says so instead of claiming it has none.
 */
function HostServerNames({ bot }: { bot: Bot }): React.JSX.Element {
  const t = useTranslate()
  const target = useStableMcpTarget(botTarget(bot))
  const { list, error } = useMcpServers(target)
  if (error) {
    // Never "none": the list wasn't read. It reads again on the next change or visit.
    return (
      <span className="block truncate text-xs text-muted-foreground" title={error}>
        {t('settings.bots.tools.hostMcpLoadFailed', 'Couldn’t load this host’s servers')}
      </span>
    )
  }
  if (!list) {
    // Still reading: nothing rather than a guess.
    return <span className="block text-xs" />
  }
  if (list.servers.length === 0) {
    return (
      <span className="block truncate text-xs text-muted-foreground">
        {t('settings.bots.tools.hostMcpNone', 'None on this host yet')}
      </span>
    )
  }
  const agent = botAgentLabel(bot.agent)
  const names = list.servers
    .filter((server) => !server.agentsOff.includes(bot.agent))
    .map((server) => mcpServerTitle(server.name))
  const off = list.servers.length - names.length
  if (names.length === 0) {
    return (
      <span className="block truncate text-xs text-muted-foreground">
        {t('settings.bots.tools.hostMcpAllOff', '{{count}} on this host, all off for {{agent}}', {
          count: off,
          agent,
          defaultValue_one: '{{count}} on this host, off for {{agent}}'
        })}
      </span>
    )
  }
  return (
    <span className="flex min-w-0 gap-1 text-xs text-muted-foreground">
      <span className="truncate">{names.join(', ')}</span>
      {off > 0 ? (
        <span className="shrink-0">
          {t('settings.bots.tools.hostMcpSomeOff', '· {{count}} off for {{agent}}', {
            count: off,
            agent,
            defaultValue_one: '· {{count}} off for {{agent}}'
          })}
        </span>
      ) : null}
    </span>
  )
}

export function BotHostMcpServersRow({
  bot,
  enabled
}: {
  bot: Bot
  enabled: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const [saving, setSaving] = useState(false)
  const title = t('settings.bots.tools.hostMcp', 'Your MCP servers')
  const set = (next: boolean): void => {
    setSaving(true)
    void callBotRpc(bot, 'bots.tools.setHostMcpServers', { botId: bot.id, enabled: next })
      .then(changed)
      .catch((error: unknown) => toast.error(botToolErrorMessage(error)))
      .finally(() => setSaving(false))
  }
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
        <Plug className="size-4 text-muted-foreground" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{title}</span>
        <HostServerNames bot={bot} />
      </span>
      <Switch
        checked={enabled}
        pending={saving ? 'saving' : undefined}
        aria-label={title}
        onCheckedChange={set}
      />
    </div>
  )
}
