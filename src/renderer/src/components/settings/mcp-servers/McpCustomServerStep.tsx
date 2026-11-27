// Custom server: the tool editor bots use, in Settings' words. One field takes a URL, a start command
// or a pasted config; a paste that names several servers lists them to add together.
import React from 'react'
import { DialogTitle } from '@/components/ui/dialog'
import { useTranslate } from '@/i18n/use-translate'
import { BotToolEditor } from '@/components/bots/BotToolEditor'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { BotToolInput, BotToolServer } from '../../../../../shared/bot-tools'
import type { McpServerWorkspaces } from '../../../../../shared/mcp-servers/mcp-servers'
import { parseMcpServersPaste } from '../../../../../shared/bot-tool-paste'
import { addMcpServer, type McpServerView } from '@/runtime/mcp-servers/mcp-servers-client'
import { useMcpHostPlatform } from './mcp-server-agents'
import { useMountedRef } from '@/hooks/useMountedRef'

const NO_PREFIXES: Readonly<Record<string, string>> = {}

export function McpCustomServerStep({
  target,
  servers,
  initial,
  onAdded,
  workspaces,
  headerPrefixes = NO_PREFIXES,
  onCancel
}: {
  target: RuntimeClientTarget
  servers: readonly McpServerView[]
  initial?: BotToolServer
  /** The server added, to sign in to or show; none after several. */
  /** Header values a catalog app puts before the token (GitHub's `Bearer `), added when it's left out. */
  headerPrefixes?: Readonly<Record<string, string>>
  /** Where each added server is on from the start; all workspaces without it. */
  workspaces?: McpServerWorkspaces
  /** The servers added: one, or every one a paste named; only while the dialog shows. */
  onAdded: (servers: McpServerView[]) => void
  onCancel: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const platform = useMcpHostPlatform(target)
  // A save that answers after the dialog closed leaves it closed.
  const mounted = useMountedRef()
  const done = (servers: McpServerView[]): void => {
    if (mounted.current) {
      onAdded(servers)
    }
  }
  const withPrefixes = (config: BotToolInput): BotToolInput =>
    'url' in config
      ? {
          ...config,
          headers: config.headers.map((row) => {
            const prefix = headerPrefixes[row.key]
            // Only the catalog app's own address, and only a bare token: a value that already
            // names a scheme ("bearer …", "token …") stays as typed.
            return prefix &&
              initial &&
              'url' in initial &&
              config.url === initial.url &&
              'value' in row &&
              /^\S+$/.test(row.value ?? '')
              ? { ...row, value: `${prefix}${row.value}` }
              : row
          })
        }
      : config
  const add = (config: BotToolInput): Promise<McpServerView> =>
    addMcpServer(target, { config: withPrefixes(config), ...(workspaces ? { workspaces } : {}) })
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
        onSave={async (config) => done([await add(config)])}
        onSaveMany={async (configs) => {
          const added: McpServerView[] = []
          // One at a time: each add rewrites the host's one list.
          for (const config of configs) {
            added.push(await add(config))
          }
          done(added)
        }}
      />
    </div>
  )
}
