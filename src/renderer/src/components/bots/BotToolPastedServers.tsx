// A paste that names several servers (an mcpServers block, mcp add lines): each one, checked to add.
import React from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { Checkbox } from '@/components/ui/checkbox'
import type { BotToolServer } from '../../../../shared/bot-tools'
import { BotToolLogo } from './apps/BotToolAppRow'

function serverLine(server: BotToolServer): string {
  return 'url' in server
    ? server.url.replace(/^https?:\/\//i, '').replace(/\/$/, '')
    : [server.command, ...server.args].join(' ')
}

export function BotToolPastedServers({
  servers,
  checked,
  taken,
  onCheckedChange
}: {
  servers: readonly BotToolServer[]
  checked: ReadonlySet<string>
  /** Names already in use: listed, never added. */
  taken: ReadonlySet<string>
  onCheckedChange: (name: string, checked: boolean) => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">
        {t('settings.mcpServers.custom.found', 'Found {{count}} servers', {
          count: servers.length
        })}
      </p>
      <ul className="divide-y divide-border rounded-lg border border-border px-3">
        {servers.map((server) => {
          const id = `pasted-server-${server.name}`
          const added = taken.has(server.name)
          return (
            <li key={server.name} className="flex min-h-11 items-center gap-3 py-2">
              <Checkbox
                id={id}
                checked={!added && checked.has(server.name)}
                disabled={added}
                onCheckedChange={(next) => onCheckedChange(server.name, next === true)}
              />
              <BotToolLogo
                name={server.name}
                detail={'url' in server ? server.url : undefined}
                size="sm"
              />
              <label htmlFor={id} className="flex min-w-0 flex-1 items-baseline gap-3">
                <span className="shrink-0 text-sm font-medium">{server.name}</span>
                <span className="min-w-0 truncate text-xs text-muted-foreground">
                  {added
                    ? t('settings.mcpServers.custom.foundTaken', 'Already added')
                    : 'url' in server
                      ? t('settings.mcpServers.custom.foundUrl', 'URL · {{line}}', {
                          line: serverLine(server)
                        })
                      : t('settings.mcpServers.custom.foundCommand', 'Command · {{line}}', {
                          line: serverLine(server)
                        })}
                </span>
              </label>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
