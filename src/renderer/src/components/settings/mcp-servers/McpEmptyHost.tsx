// A host with no servers anywhere: Add a server, or, on another host, copy this computer's list.
// Copying adds each URL and command again on that host; saved values and sign-ins stay behind.
import React, { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { translateLocalExecutionHostLabel } from '@/runtime/hosts/display/execution-host-label'
import { botToolErrorMessage } from '@/components/bots/bot-tools-client'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { BotToolInput } from '../../../../../shared/bot-tools'
import {
  addMcpServer,
  readMcpServerDetails,
  readMcpServerList,
  type McpServerDetails
} from '@/runtime/mcp-servers/mcp-servers-client'

const LOCAL: RuntimeClientTarget = { kind: 'local' }

/** The server as another host adds it: the same address or command, without its saved values. */
function withoutSecrets({ server }: McpServerDetails): BotToolInput {
  return 'url' in server
    ? { name: server.name, url: server.url, transport: 'http', headers: [] }
    : { name: server.name, command: server.command, args: server.args, env: [] }
}

export function McpEmptyHost({
  target,
  hostName,
  onAdd
}: {
  target: RuntimeClientTarget
  hostName: string
  onAdd: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const localName = translateLocalExecutionHostLabel(undefined, t)
  // Ids of this computer's own servers, when it has any and Settings shows another host.
  const [localIds, setLocalIds] = useState<string[]>([])
  const [copying, setCopying] = useState(false)
  const remote = target.kind === 'environment'
  useEffect(() => {
    if (!remote) {
      return
    }
    let live = true
    void readMcpServerList(LOCAL).then(
      (list) => {
        if (live) {
          setLocalIds(list.servers.filter((server) => !server.plugin).map((server) => server.id))
        }
      },
      // This computer without MCP servers on offers nothing to copy.
      () => undefined
    )
    return () => {
      live = false
    }
  }, [remote])

  const copy = (): void => {
    setCopying(true)
    void (async () => {
      for (const id of localIds) {
        const details = await readMcpServerDetails(LOCAL, id)
        await addMcpServer(target, { config: withoutSecrets(details) })
      }
    })()
      .then(() =>
        toast.success(
          t('settings.mcpServers.empty.copied', 'Copied {{count}} servers from {{host}}', {
            count: localIds.length,
            host: localName
          })
        )
      )
      .catch((error: unknown) => toast.error(botToolErrorMessage(error)))
      .finally(() => setCopying(false))
  }

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-xl border border-dashed border-border px-4 py-3">
      <p className="min-w-0 flex-1 text-sm text-muted-foreground">
        {t('settings.mcpServers.empty.title', 'No MCP servers on {{host}}', { host: hostName })}
      </p>
      <div className="flex shrink-0 items-center gap-2">
        <Button variant="outline" size="sm" disabled={copying} onClick={onAdd}>
          {t('settings.mcpServers.addServer', 'Add a server')}
        </Button>
        {remote && localIds.length > 0 ? (
          <Button size="sm" disabled={copying} onClick={copy}>
            {t('settings.mcpServers.empty.copyFrom', 'Copy from {{host}}', { host: localName })}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
