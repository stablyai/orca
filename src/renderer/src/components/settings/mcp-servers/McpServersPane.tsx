// Settings › MCP servers: the picked host's servers by where they come from. Yours (added in Orca),
// From plugins, and In your agents (set up inside an agent, with Move to Orca).
import React, { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useConfirmationDialog } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { botToolErrorMessage } from '@/components/bots/bot-tools-client'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { DiscoveredMcpServer } from '../../../../../shared/mcp-servers/mcp-servers'
import { getRuntimeTargetHostId } from '@/runtime/rpc/targets/runtime-client-target'
import { importMcpServer, type McpServerView } from '@/runtime/mcp-servers/mcp-servers-client'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { useMcpServers, useStableMcpTarget } from './use-mcp-servers'
import { useMcpServerAgents } from './mcp-server-agents'
import { useMcpHostWorkspaces } from './use-mcp-host-workspaces'
import { summarizeMcpWorkspaces } from './mcp-server-workspace-choice'
import {
  mcpAgentNames,
  mcpAgentsSummary,
  mcpServerLine,
  mcpServerNeedsSignIn,
  mcpServerStatus,
  mcpServerTitle,
  mcpWorkspacesSummaryText
} from './mcp-server-words'
import { McpAddServerRow, McpDiscoveredRow, McpServerListRow } from './McpServerRows'
import { McpServerSignInDialog, type McpSignInServer } from './McpServerSignInDialog'
import { McpServersAddDialog } from './McpServersAddDialog'
import { McpEmptyHost } from './McpEmptyHost'

export function McpServersPane({
  target: given,
  hostName,
  onOpenServer
}: {
  target: RuntimeClientTarget
  hostName: string
  onOpenServer: (id: string, title: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  const confirm = useConfirmationDialog()
  const target = useStableMcpTarget(given)
  const { list, discovered, problems, error } = useMcpServers(target, true)
  const agents = useMcpServerAgents(target)
  const workspaces = useMcpHostWorkspaces(target)
  const [adding, setAdding] = useState(false)
  const [signingIn, setSigningIn] = useState<McpSignInServer | null>(null)
  const [moving, setMoving] = useState<ReadonlySet<string>>(new Set())

  if (!list) {
    return (
      <p className="px-1 text-sm text-muted-foreground" role="status">
        {error ?? t('settings.mcpServers.loading', 'Reading MCP servers…')}
      </p>
    )
  }

  const own = list.servers.filter((server) => !server.plugin)
  const fromPlugins = list.servers.filter((server) => server.plugin)
  const summary = (server: McpServerView): string => {
    const agentWords = mcpAgentsSummary(server, agents, t)
    const where = summarizeMcpWorkspaces(server.workspaces, workspaces)
    return where.kind === 'all'
      ? agentWords
      : `${agentWords} · ${mcpWorkspacesSummaryText(where, t)}`
  }
  const row = (server: McpServerView, line: string): React.JSX.Element => {
    const title = mcpServerTitle(server.name)
    return (
      <McpServerListRow
        key={server.id}
        name={server.name}
        detail={server.detail}
        line={line}
        status={mcpServerStatus(server, problems[server.id], hostName, t)}
        summary={summary(server)}
        onOpen={() => onOpenServer(server.id, title)}
        onSignIn={
          mcpServerNeedsSignIn(server)
            ? () => setSigningIn({ id: server.id, name: server.name, detail: server.detail })
            : undefined
        }
      />
    )
  }

  const runImport = (servers: readonly DiscoveredMcpServer[], mode: 'move' | 'copy'): void => {
    const keys = servers.map((server) => server.key)
    setMoving((current) => new Set([...current, ...keys]))
    void (async () => {
      // One at a time: each move edits the same agent files.
      for (const server of servers) {
        await importMcpServer(target, server.key, mode)
      }
    })()
      .then(() => {
        if (mode === 'copy') {
          toast.success(
            t('settings.mcpServers.found.copied', 'Copied {{name}} to Orca', {
              name: mcpServerTitle(servers[0]?.name ?? '')
            })
          )
        }
      })
      .catch((caught: unknown) => toast.error(botToolErrorMessage(caught)))
      .finally(() =>
        setMoving((current) => new Set([...current].filter((key) => !keys.includes(key))))
      )
  }
  const move = async (servers: readonly DiscoveredMcpServer[]): Promise<void> => {
    const one = servers.length === 1 ? servers[0] : undefined
    const agentNames = mcpAgentNames(
      [...new Set(servers.flatMap((server) => server.agents))],
      locale
    )
    const ok = await confirm({
      title: one
        ? t('settings.mcpServers.move.title', 'Move {{name}} to Orca?', {
            name: mcpServerTitle(one.name)
          })
        : t('settings.mcpServers.move.allTitle', 'Move {{count}} servers to Orca?', {
            count: servers.length
          }),
      description: one
        ? t(
            'settings.mcpServers.move.line',
            'Orca removes it from {{agents}} settings and keeps a backup.',
            { agents: agentNames }
          )
        : t(
            'settings.mcpServers.move.allLine',
            'Orca removes them from {{agents}} settings and keeps a backup.',
            { agents: agentNames }
          ),
      confirmLabel: t('settings.mcpServers.move.confirm', 'Move')
    })
    if (ok) {
      runImport(servers, 'move')
    }
  }

  const movable = discovered.filter((server) => server.movable)
  const foundAgents = mcpAgentNames(
    [...new Set(discovered.flatMap((server) => server.agents))],
    locale
  )
  const firstRun = own.length === 0 && discovered.length > 0
  const foundGroup =
    discovered.length > 0 ? (
      <SettingsGroup
        title={t('settings.mcpServers.found.title', 'In your agents')}
        description={
          firstRun
            ? t('settings.mcpServers.found.summary', 'Found {{count}} servers in {{agents}}', {
                count: discovered.length,
                agents: foundAgents
              })
            : undefined
        }
        action={
          firstRun && movable.length > 1 ? (
            <Button variant="outline" size="sm" onClick={() => void move(movable)}>
              {t('settings.mcpServers.found.moveAll', 'Move all to Orca')}
            </Button>
          ) : undefined
        }
      >
        {discovered.map((server) => (
          <McpDiscoveredRow
            key={server.key}
            server={server}
            busy={moving.has(server.key)}
            onMove={() => void move([server])}
            onCopy={() => runImport([server], 'copy')}
            onOpenFile={
              target.kind === 'local'
                ? (path) => void window.api.shell.openFilePath(path, getRuntimeTargetHostId(target))
                : undefined
            }
          />
        ))}
      </SettingsGroup>
    ) : null
  const addRow = (
    <McpAddServerRow
      label={t('settings.mcpServers.addServer', 'Add a server')}
      onOpen={() => setAdding(true)}
    />
  )
  const empty = own.length === 0 && fromPlugins.length === 0 && discovered.length === 0

  return (
    <>
      {empty ? (
        <McpEmptyHost target={target} hostName={hostName} onAdd={() => setAdding(true)} />
      ) : (
        <>
          {firstRun ? foundGroup : null}
          <SettingsGroup title={t('settings.mcpServers.yours', 'Yours')}>
            {own.map((server) => row(server, mcpServerLine(server)))}
            {addRow}
          </SettingsGroup>
          {fromPlugins.length > 0 ? (
            <SettingsGroup title={t('settings.mcpServers.fromPlugins', 'From plugins')}>
              {fromPlugins.map((server) => row(server, server.plugin?.name ?? ''))}
            </SettingsGroup>
          ) : null}
          {firstRun ? null : foundGroup}
        </>
      )}
      <McpServersAddDialog
        target={target}
        servers={list.servers}
        open={adding}
        onOpenChange={setAdding}
        onSignIn={setSigningIn}
        onManage={(server) => onOpenServer(server.id, mcpServerTitle(server.name))}
      />
      <McpServerSignInDialog
        target={target}
        hostName={hostName}
        server={signingIn}
        onClose={() => setSigningIn(null)}
      />
    </>
  )
}
