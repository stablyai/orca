import { useCallback, useEffect, useRef, useState } from 'react'
import { Ellipsis, RefreshCw } from 'lucide-react'
import { LoadingSpinner } from '@/components/LoadingSpinner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { SecuritySurface } from '@/components/ui/security-surface'
import { useTranslate } from '@/i18n/use-translate'
import { callStructuredAgentSession } from '@/runtime/native-chat/requests/structured-agent-session-call'
import type { AgentSessionMcpResult } from '../../../../../../shared/agent-session/agent-session-mcp'
import {
  createAgentSessionMcpHook,
  type AgentSessionMcpRequest
} from '../../../../../../shared/agent-session/view/use-agent-session-mcp'
import { primaryAgentSessionMcpAction } from '../../../../../../shared/agent-session/view/agent-session-mcp-actions'
import type { NativeChatStructuredComposerTransport } from '../submit/native-chat-structured-composer-transport'
import type { NativeChatComposerNotice } from './native-chat-composer-notice'
import { NativeChatComposerNotices } from './NativeChatComposerNotices'

const useAgentSessionMcp = createAgentSessionMcpHook({ useCallback, useEffect, useRef, useState })

export function NativeChatMcpPanel({
  transport,
  fallback
}: {
  transport: Pick<NativeChatStructuredComposerTransport, 'sessionId' | 'runtimeEnvironmentId'>
  fallback: NativeChatComposerNotice | null
}): React.JSX.Element {
  const t = useTranslate()
  const { sessionId, runtimeEnvironmentId } = transport
  const request = useCallback<AgentSessionMcpRequest>(
    (operation) =>
      callStructuredAgentSession<AgentSessionMcpResult>(
        runtimeEnvironmentId
          ? { kind: 'environment', environmentId: runtimeEnvironmentId }
          : { kind: 'local' },
        'agentSession.mcp',
        { sessionId, operation }
      ),
    [runtimeEnvironmentId, sessionId]
  )
  const { servers, pending, failure, run } = useAgentSessionMcp(request)
  const statusLabel = {
    connected: t('components.native-chat.mcp.connected', 'Connected'),
    failed: t('components.native-chat.mcp.failed', 'Connection failed'),
    'needs-auth': t('components.native-chat.mcp.needsAuth', 'Sign-in required'),
    pending: t('components.native-chat.mcp.pending', 'Connecting'),
    disabled: t('components.native-chat.mcp.disabled', 'Disabled')
  }
  return (
    <SecuritySurface>
      <section
        aria-label={t('components.native-chat.mcp.servers', 'MCP servers')}
        className="mb-2 space-y-3 rounded-md border border-border bg-card p-3 text-sm text-card-foreground"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium">
            {t('components.native-chat.mcp.servers', 'MCP servers')}
          </span>
          <Button
            size="sm"
            className="pointer-coarse:min-h-11"
            variant="ghost"
            disabled={pending !== null}
            onClick={() => void run({ action: 'status' })}
          >
            <RefreshCw aria-hidden />
            {t('components.native-chat.mcp.refresh', 'Refresh')}
          </Button>
        </div>
        {pending && (
          <p role="status" className="flex items-start gap-2 text-xs text-muted-foreground">
            <LoadingSpinner className="size-4 shrink-0" />
            <span>
              {pending.action === 'authenticate'
                ? t(
                    'components.native-chat.mcp.waitingForConsent',
                    'Finish sign-in in the browser on the computer running Claude. Waiting up to 3 minutes…'
                  )
                : t(
                    'components.native-chat.mcp.checking',
                    'Checking the session’s MCP connection…'
                  )}
            </span>
          </p>
        )}
        {servers?.length === 0 && !pending && (
          <p className="text-xs text-muted-foreground">
            {t('components.native-chat.mcp.empty', 'This session reports no MCP servers.')}
          </p>
        )}
        <div className="scrollbar-sleek max-h-64 overflow-y-auto">
          {servers?.map((server) => {
            const primary = primaryAgentSessionMcpAction(server)
            const locked = pending !== null || failure !== null
            return (
              <div
                key={server.name}
                className="flex items-center gap-2 border-t border-border py-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="break-words font-medium">{server.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {failure
                      ? t('components.native-chat.mcp.lastChecked', 'Last checked: {{status}}', {
                          status: statusLabel[server.status]
                        })
                      : statusLabel[server.status]}
                  </div>
                </div>
                {primary && (
                  <Button
                    size="sm"
                    className="pointer-coarse:min-h-11"
                    variant={primary.action === 'authenticate' ? 'default' : 'outline'}
                    disabled={locked}
                    onClick={() => void run(primary)}
                  >
                    {primary.action === 'authenticate'
                      ? t('components.native-chat.mcp.authenticate', 'Sign in')
                      : primary.action === 'toggle'
                        ? t('components.native-chat.mcp.enable', 'Enable')
                        : t('components.native-chat.mcp.reconnect', 'Reconnect')}
                  </Button>
                )}
                {server.status !== 'disabled' && (
                  <DropdownMenu>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <DropdownMenuTrigger asChild>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            className="pointer-coarse:size-11"
                            disabled={locked}
                            aria-label={t(
                              'components.native-chat.mcp.moreActions',
                              'Actions for {{server}}',
                              { server: server.name }
                            )}
                          >
                            <Ellipsis aria-hidden />
                          </Button>
                        </DropdownMenuTrigger>
                      </TooltipTrigger>
                      <TooltipContent>
                        {t('components.native-chat.mcp.moreActions', 'Actions for {{server}}', {
                          server: server.name
                        })}
                      </TooltipContent>
                    </Tooltip>
                    <SecuritySurface>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onSelect={() => void run({ action: 'reconnect', server: server.name })}
                        >
                          {t('components.native-chat.mcp.reconnect', 'Reconnect')}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() =>
                            void run({ action: 'toggle', server: server.name, enabled: false })
                          }
                        >
                          {t('components.native-chat.mcp.disable', 'Disable')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </SecuritySurface>
                  </DropdownMenu>
                )}
              </div>
            )
          })}
        </div>
        {!pending &&
          !failure &&
          servers?.some((server) => server.status === 'needs-auth' && server.canAuthenticate) && (
            <p className="text-xs text-muted-foreground">
              {t(
                'components.native-chat.mcp.remoteBrowser',
                'Use a browser on the computer running Claude so the sign-in callback reaches that computer.'
              )}
            </p>
          )}
        {(failure ||
          servers?.some((server) => server.status === 'needs-auth' && !server.canAuthenticate)) && (
          <>
            <p role="alert" className="text-xs text-muted-foreground">
              {failure
                ? t(
                    'components.native-chat.mcp.actionUnavailable',
                    'The action could not be confirmed. Refresh to check the connection before trying again.'
                  )
                : t(
                    'components.native-chat.mcp.terminalRequired',
                    'This server requires sign-in from the Claude terminal on its computer.'
                  )}
            </p>
            {fallback && <NativeChatComposerNotices notices={[fallback]} />}
          </>
        )}
      </section>
    </SecuritySurface>
  )
}
