// Settings › MCP servers › one server: its sign-in, its own details, which agents and workspaces get it,
// and Remove. A plugin's server keeps its details and stays; its switches still work.
import React, { useEffect, useState } from 'react'
import { Ellipsis, LogOut, RefreshCw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useConfirmationDialog } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { useTranslate } from '@/i18n/use-translate'
import { BotToolLogo } from '@/components/bots/apps/BotToolAppRow'
import { botToolErrorMessage } from '@/components/bots/bot-tools-client'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import {
  removeMcpServer,
  signOutMcpServer,
  type McpServerView
} from '@/runtime/mcp-servers/mcp-servers-client'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { useMcpServers, useStableMcpTarget } from './use-mcp-servers'
import { useMcpHostPlatform, useMcpServerAgents } from './mcp-server-agents'
import { useMcpHostWorkspaces } from './use-mcp-host-workspaces'
import {
  mcpServerLine,
  mcpServerNeedsSignIn,
  mcpServerTitle,
  mcpServerUnreadable
} from './mcp-server-words'
import { McpStatusLine } from './McpServerRows'
import { McpServerLaunchGroup } from './McpServerLaunchGroup'
import { McpServerAgentsGroup } from './McpServerAgentsGroup'
import { McpServerWorkspacesGroup } from './McpServerWorkspacesGroup'
import { McpServerSignInDialog, type McpSignInServer } from './McpServerSignInDialog'
import { showMcpServerChangeToast } from './mcp-server-change-toast'

function SignInRow({
  target,
  server,
  onSignIn
}: {
  target: RuntimeClientTarget
  server: McpServerView
  onSignIn: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const needs = mcpServerNeedsSignIn(server)
  const unreadable = mcpServerUnreadable(server)
  return (
    <SettingsGroup>
      <div data-settings-row="" className="flex min-h-12 items-center gap-3 py-2">
        <span className="min-w-0 flex-1 text-sm">
          {needs ? (
            <McpStatusLine
              line={
                unreadable
                  ? t(
                      'settings.mcpServers.unreadable',
                      'Saved sign-in or key can’t be opened on this computer'
                    )
                  : null
              }
              status={{
                label: unreadable
                  ? t('settings.mcpServers.signInAgain', 'Sign in again')
                  : t('settings.mcpServers.status.needsSignIn', 'Needs sign-in'),
                tone: 'attention',
                replacesLine: false
              }}
            />
          ) : (
            t('settings.mcpServers.status.signedIn', 'Signed in')
          )}
        </span>
        {needs ? (
          <Button variant="secondary" size="pill" onClick={onSignIn}>
            {t('settings.mcpServers.signIn', 'Sign in')}
          </Button>
        ) : (
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('settings.mcpServers.signInActions', 'Sign-in actions')}
              >
                <Ellipsis className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={onSignIn}>
                <RefreshCw />
                {t('settings.mcpServers.signInAgain', 'Sign in again')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onSelect={() =>
                  void signOutMcpServer(target, server.id).then(
                    () =>
                      showMcpServerChangeToast(
                        target,
                        t('settings.mcpServers.toast.signedOut', 'Signed out of {{name}}', {
                          name: mcpServerTitle(server.name)
                        })
                      ),
                    (error: unknown) => toast.error(botToolErrorMessage(error))
                  )
                }
              >
                <LogOut />
                {t('settings.mcpServers.signOut', 'Sign out')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </SettingsGroup>
  )
}

export function McpServerPage({
  target: given,
  hostName,
  serverId,
  onTitle,
  onBack
}: {
  target: RuntimeClientTarget
  hostName: string
  serverId: string
  /** The breadcrumb's name once the server is read. */
  onTitle: (title: string) => void
  /** Back to the list: the server is gone, or was removed here. */
  onBack: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const confirm = useConfirmationDialog()
  const target = useStableMcpTarget(given)
  const { list, error } = useMcpServers(target)
  const agents = useMcpServerAgents(target)
  const workspaces = useMcpHostWorkspaces(target)
  const platform = useMcpHostPlatform(target)
  const [signingIn, setSigningIn] = useState<McpSignInServer | null>(null)
  const server = list?.servers.find((entry) => entry.id === serverId)
  const title = server ? mcpServerTitle(server.name) : null
  useEffect(() => {
    if (title) {
      onTitle(title)
    }
  }, [title, onTitle])
  const gone = list !== null && !server
  useEffect(() => {
    if (gone) {
      onBack()
    }
  }, [gone, onBack])

  if (!server || !list) {
    return (
      <p className="px-1 text-sm text-muted-foreground" role="status">
        {error ?? t('settings.mcpServers.loading', 'Reading MCP servers…')}
      </p>
    )
  }
  const plugin = server.plugin !== undefined
  // An entry that doesn't open may have been a key: its details stay editable to enter it again.
  const editable = !server.signIn || mcpServerUnreadable(server)
  const remove = async (): Promise<void> => {
    const name = mcpServerTitle(server.name)
    const ok = await confirm({
      title: t('settings.mcpServers.remove.title', 'Remove {{name}}?', { name }),
      description: t(
        'settings.mcpServers.remove.line',
        'New sessions on {{host}} won’t have it. Its saved values and sign-in are deleted.',
        { host: hostName }
      ),
      confirmLabel: t('settings.mcpServers.remove.confirm', 'Remove'),
      confirmVariant: 'destructive'
    })
    if (!ok) {
      return
    }
    try {
      await removeMcpServer(target, server.id)
      onBack()
      void showMcpServerChangeToast(
        target,
        t('settings.mcpServers.toast.removed', '{{name}} removed', { name })
      )
    } catch (caught) {
      toast.error(botToolErrorMessage(caught))
    }
  }

  return (
    <>
      <div className="flex items-center gap-4 border-b border-border/60 pb-5">
        <BotToolLogo name={server.name} detail={server.detail} size="lg" />
        <div className="min-w-0 space-y-1">
          <h2 className="truncate text-2xl leading-tight font-semibold">{title}</h2>
          <p className="truncate font-mono text-xs text-muted-foreground">
            {plugin ? server.plugin?.name : mcpServerLine(server)}
          </p>
        </div>
      </div>
      {server.signIn ? (
        <SignInRow
          target={target}
          server={server}
          onSignIn={() => setSigningIn({ id: server.id, name: server.name, detail: server.detail })}
        />
      ) : null}
      {editable || server.transport === 'command' ? (
        <McpServerLaunchGroup
          target={target}
          server={server}
          platform={platform}
          readOnly={plugin}
        />
      ) : null}
      {agents && agents.length > 0 ? (
        <McpServerAgentsGroup
          target={target}
          server={server}
          agents={agents}
          agentFiles={list.agentFiles}
          agentProblems={list.agentProblems}
        />
      ) : null}
      <McpServerWorkspacesGroup target={target} server={server} workspaces={workspaces} />
      {plugin ? null : (
        <div>
          <Button
            variant="ghost-destructive"
            size="sm"
            className="-ml-3"
            onClick={() => void remove()}
          >
            <Trash2 />
            {t('settings.mcpServers.remove.button', 'Remove server')}
          </Button>
        </div>
      )}
      <McpServerSignInDialog
        target={target}
        hostName={hostName}
        server={signingIn}
        onClose={() => setSigningIn(null)}
      />
    </>
  )
}
