// Repository settings › MCP servers, on a host that serves them: which of the host's servers are on in
// this repo (the same Workspaces choice a server's page edits), then the servers its own files define.
import React, { useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { useTranslate } from '@/i18n/use-translate'
import { BotToolLogo } from '@/components/bots/apps/BotToolAppRow'
import { botToolErrorMessage } from '@/components/bots/bot-tools-client'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import {
  setMcpServerWorkspaces,
  type McpServerView
} from '@/runtime/mcp-servers/mcp-servers-client'
import { SettingsGroup, SettingsGroupSubsection } from '../../section-layout/SettingsGroup'
import { useMcpServers, useStableMcpTarget } from '../../mcp-servers/use-mcp-servers'
import { isMcpWorkspaceOn, withMcpWorkspace } from '../../mcp-servers/mcp-server-workspace-choice'
import { mcpServerLine, mcpServerTitle } from '../../mcp-servers/mcp-server-words'
import { McpAddServerRow } from '../../mcp-servers/McpServerRows'
import { McpServersAddDialog } from '../../mcp-servers/McpServersAddDialog'
import {
  McpServerSignInDialog,
  type McpSignInServer
} from '../../mcp-servers/McpServerSignInDialog'
import { showMcpServerChangeToast } from '../../mcp-servers/mcp-server-change-toast'
import { useSettingsHostLabel } from '../../host-scope/use-host-setting'
import { useRepoMcpConfigs } from './use-repo-mcp-configs'
import { McpConfigFileRow } from './McpConfigFileRow'
import { openMcpServersSettings } from '../../navigation/open-mcp-servers-settings'

function ServerRow({
  name,
  detail,
  line,
  control
}: {
  name: string
  detail?: string
  line: string
  control?: React.ReactNode
}): React.JSX.Element {
  return (
    <div data-settings-row="">
      <div className="flex min-h-[42px] items-center gap-3">
        <BotToolLogo name={name} detail={detail} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm leading-5 font-medium">{name}</span>
          <span className="block truncate text-xs leading-4 text-muted-foreground">{line}</span>
        </span>
        {control}
      </div>
    </div>
  )
}

export function McpRepoServersSection({
  repo,
  target: given
}: {
  repo: Repo
  target: RuntimeClientTarget
}): React.JSX.Element {
  const t = useTranslate()
  const target = useStableMcpTarget(given)
  const hostName = useSettingsHostLabel(target)
  const { list, error } = useMcpServers(target)
  const files = useRepoMcpConfigs(repo)
  const [adding, setAdding] = useState(false)
  const [signingIn, setSigningIn] = useState<McpSignInServer | null>(null)
  const servers = list?.servers ?? []
  const fileServers = files.visibleConfigs.flatMap((config) =>
    config.status === 'valid' ? config.servers.map((server) => ({ server, config })) : []
  )
  // Each file that gives servers gets its Open; one Orca can't read says why, as MCP configs does.
  const contributing = files.visibleConfigs.filter(
    (config) => config.status === 'valid' && config.servers.length > 0
  )
  const broken = files.visibleConfigs.filter(
    (config) => config.status !== 'valid' || config.readError
  )

  const setOn = (server: McpServerView, on: boolean): void => {
    void setMcpServerWorkspaces(
      target,
      server.id,
      withMcpWorkspace(server.workspaces, repo.id, on),
      server.workspaces
    )
      .then(() =>
        showMcpServerChangeToast(
          target,
          on
            ? t('settings.mcpServers.toast.repoOn', '{{name}} turned on in {{repo}}', {
                name: mcpServerTitle(server.name),
                repo: repo.displayName
              })
            : t('settings.mcpServers.toast.repoOff', '{{name}} turned off in {{repo}}', {
                name: mcpServerTitle(server.name),
                repo: repo.displayName
              })
        )
      )
      .catch((error: unknown) => toast.error(botToolErrorMessage(error)))
  }

  return (
    <SettingsGroup title={t('settings.mcpServers.title', 'MCP servers')}>
      <SettingsGroupSubsection title={t('settings.mcpServers.repo.on', 'On in this repo')}>
        {error ? (
          <p data-settings-row="" className="text-xs text-muted-foreground">
            {error}
          </p>
        ) : null}
        {servers.map((server) => {
          const title = mcpServerTitle(server.name)
          return (
            <ServerRow
              key={server.id}
              name={title}
              detail={server.detail}
              line={server.plugin ? server.plugin.name : mcpServerLine(server)}
              control={
                <Switch
                  checked={isMcpWorkspaceOn(server.workspaces, repo.id)}
                  aria-label={title}
                  onCheckedChange={(on) => setOn(server, on)}
                />
              }
            />
          )
        })}
        <McpAddServerRow
          label={t('settings.mcpServers.repo.add', 'Add a server for this repo')}
          onOpen={() => setAdding(true)}
        />
      </SettingsGroupSubsection>
      {fileServers.length > 0 || broken.length > 0 || files.inspectionUnavailableMessage ? (
        <SettingsGroupSubsection
          title={t('settings.mcpServers.repo.files', 'From this repo’s files')}
          action={
            contributing.length > 0 ? (
              <span className="flex items-center gap-1">
                {contributing.map((config) => (
                  <Button
                    key={config.candidate.relativePath}
                    variant="ghost"
                    size="xs"
                    onClick={() => files.handleOpen(config)}
                  >
                    <ExternalLink />
                    {t('settings.mcpServers.repo.open', 'Open {{file}}', {
                      file: config.candidate.relativePath
                    })}
                  </Button>
                ))}
              </span>
            ) : undefined
          }
        >
          {fileServers.map(({ server, config }) => (
            <ServerRow
              key={`${config.candidate.relativePath}:${server.name}`}
              name={server.name}
              detail={server.url}
              line={`${(server.url ?? server.command ?? '').replace(/^https?:\/\//i, '')} · ${config.candidate.relativePath}`}
            />
          ))}
          {broken.map((config) => (
            <McpConfigFileRow
              key={config.candidate.relativePath}
              config={config}
              onOpen={files.handleOpen}
            />
          ))}
          {files.inspectionUnavailableMessage ? (
            <p data-settings-row="" className="text-xs text-muted-foreground">
              {files.inspectionUnavailableMessage}
            </p>
          ) : null}
        </SettingsGroupSubsection>
      ) : null}
      <McpServersAddDialog
        target={target}
        servers={servers}
        open={adding}
        onOpenChange={setAdding}
        onSignIn={setSigningIn}
        workspaces={{ later: false, on: [repo.id], off: [] }}
        onManage={(server) => openMcpServersSettings(target, server.id)}
      />
      <McpServerSignInDialog
        target={target}
        hostName={hostName}
        server={signingIn}
        onClose={() => setSigningIn(null)}
      />
    </SettingsGroup>
  )
}
