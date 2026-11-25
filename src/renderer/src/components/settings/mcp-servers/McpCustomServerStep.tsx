// Custom server: the tool editor bots use, in Settings' words. One field takes a URL, a start command
// or a pasted config; a paste that names several servers lists them to add together.
import React from 'react'
import { DialogTitle } from '@/components/ui/dialog'
import { useTranslate } from '@/i18n/use-translate'
import { BotToolEditor } from '@/components/bots/BotToolEditor'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { BotToolServer } from '../../../../../shared/bot-tools'
import { parseMcpServersPaste } from '../../../../../shared/bot-tool-paste'
import { addMcpServer, type McpServerView } from '@/runtime/mcp-servers/mcp-servers-client'
import { useMcpHostPlatform } from './mcp-server-agents'
import { useMountedRef } from '@/hooks/useMountedRef'

export function McpCustomServerStep({
  target,
  servers,
  initial,
  onAdded,
  onCancel
}: {
  target: RuntimeClientTarget
  servers: readonly McpServerView[]
  initial?: BotToolServer
  /** The server added, to sign in to or show; none after several. */
  onAdded: (server: McpServerView | null) => void
  onCancel: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const platform = useMcpHostPlatform(target)
  // A save that answers after the dialog closed leaves it closed.
  const mounted = useMountedRef()
  const done = (server: McpServerView | null): void => {
    if (mounted.current) {
      onAdded(server)
    }
  }
  return (
    <div className="scrollbar-sleek min-h-0 space-y-4 overflow-y-auto p-6">
      <DialogTitle>{t('settings.mcpServers.custom.title', 'Custom server')}</DialogTitle>
      <BotToolEditor
        context={{ platform }}
        host={null}
        initial={initial}
        taken={new Set(servers.map((server) => server.name))}
        words={{
          sourceLabel: t(
            'settings.mcpServers.custom.sourceLabel',
            'Server URL, start command or config'
          ),
          sourceHint: t(
            'settings.mcpServers.custom.sourceHint',
            'Paste a server URL, start command or config, or enter the details yourself.'
          ),
          nameTaken: (name) =>
            t(
              'settings.mcpServers.custom.nameTaken',
              'A server named {{name}} already exists. Choose another name.',
              { name }
            )
        }}
        parsePaste={(text) => parseMcpServersPaste(text, platform, t)}
        onCancel={onCancel}
        onSave={async (config) => done(await addMcpServer(target, { config }))}
        onSaveMany={async (configs) => {
          // One at a time: each add rewrites the host's one list.
          for (const config of configs) {
            await addMcpServer(target, { config })
          }
          done(null)
        }}
      />
    </div>
  )
}
