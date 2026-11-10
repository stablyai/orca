import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { SecuritySurface } from '@/components/ui/security-surface'
import { useTranslate } from '@/i18n/use-translate'
import { callStructuredAgentSession } from '@/runtime/native-chat/requests/structured-agent-session-call'
import type {
  AgentSessionMcpAction,
  AgentSessionMcpResult
} from '../../../../../../shared/agent-session/agent-session-mcp'
import type { NativeChatStructuredComposerTransport } from '../submit/native-chat-structured-composer-transport'
import type { NativeChatComposerNotice } from './native-chat-composer-notice'
import { NativeChatComposerNotices } from './NativeChatComposerNotices'

export function NativeChatMcpPanel({
  transport,
  fallback
}: {
  transport: Pick<NativeChatStructuredComposerTransport, 'sessionId' | 'runtimeEnvironmentId'>
  fallback: NativeChatComposerNotice | null
}): React.JSX.Element {
  const t = useTranslate()
  const [result, setResult] = useState<AgentSessionMcpResult | null>(null)
  const [pending, setPending] = useState<AgentSessionMcpAction | null>(null)
  const busy = useRef(false)
  const generation = useRef(0)
  const { sessionId, runtimeEnvironmentId } = transport
  const run = useCallback(
    async (operation: AgentSessionMcpAction) => {
      if (busy.current) {
        return
      }
      busy.current = true
      const owner = generation.current
      setPending(operation)
      const reply = await callStructuredAgentSession<AgentSessionMcpResult>(
        runtimeEnvironmentId
          ? { kind: 'environment', environmentId: runtimeEnvironmentId }
          : { kind: 'local' },
        'agentSession.mcp',
        { sessionId, operation }
      ).catch((): AgentSessionMcpResult => ({ status: 'unavailable' }))
      if (generation.current === owner) {
        setResult(reply)
        setPending(null)
        busy.current = false
      }
    },
    [runtimeEnvironmentId, sessionId]
  )
  useEffect(() => {
    busy.current = false
    setResult(null)
    void run({ action: 'status' })
    return () => {
      generation.current += 1
    }
  }, [run])
  const servers = result?.status === 'ok' ? result.servers : []
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
            size="xs"
            variant="outline"
            disabled={pending !== null}
            onClick={() => void run({ action: 'status' })}
          >
            {t('components.native-chat.mcp.refresh', 'Refresh')}
          </Button>
        </div>
        {pending && (
          <p role="status" className="text-xs text-muted-foreground">
            {pending.action === 'authenticate'
              ? t(
                  'components.native-chat.mcp.waitingForConsent',
                  'Waiting for you to finish sign-in in the browser on the computer running Claude. This can take up to 3 minutes.'
                )
              : t('components.native-chat.mcp.checking', 'Checking the session’s MCP connection…')}
          </p>
        )}
        {result?.status === 'ok' && servers.length === 0 && (
          <p className="text-xs text-muted-foreground">
            {t('components.native-chat.mcp.empty', 'This session reports no MCP servers.')}
          </p>
        )}
        {servers.map((server) => (
          <div
            key={server.name}
            className="flex flex-wrap items-center gap-2 border-t border-border pt-2"
          >
            <div className="min-w-0 flex-1 basis-32">
              <div className="break-words font-medium">{server.name}</div>
              <div className="text-xs text-muted-foreground">{statusLabel[server.status]}</div>
            </div>
            {server.canAuthenticate &&
              server.status !== 'connected' &&
              server.status !== 'disabled' && (
                <Button
                  size="xs"
                  disabled={pending !== null}
                  onClick={() => void run({ action: 'authenticate', server: server.name })}
                >
                  {t('components.native-chat.mcp.authenticate', 'Sign in')}
                </Button>
              )}
            {server.status !== 'disabled' && (
              <Button
                size="xs"
                variant="outline"
                disabled={pending !== null}
                onClick={() => void run({ action: 'reconnect', server: server.name })}
              >
                {t('components.native-chat.mcp.reconnect', 'Reconnect')}
              </Button>
            )}
            <Button
              size="xs"
              variant="outline"
              disabled={pending !== null}
              onClick={() =>
                void run({
                  action: 'toggle',
                  server: server.name,
                  enabled: server.status === 'disabled'
                })
              }
            >
              {server.status === 'disabled'
                ? t('components.native-chat.mcp.enable', 'Enable')
                : t('components.native-chat.mcp.disable', 'Disable')}
            </Button>
          </div>
        ))}
        {result &&
          (result.status !== 'ok' ||
            servers.some(
              (server) => server.status === 'needs-auth' && !server.canAuthenticate
            )) && (
            <>
              <p role="alert" className="text-xs text-muted-foreground">
                {t(
                  'components.native-chat.mcp.actionUnavailable',
                  'MCP controls could not complete on this session. Refresh to check its state. An active Claude session and a compatible host are required.'
                )}
              </p>
              {fallback && <NativeChatComposerNotices notices={[fallback]} />}
            </>
          )}
      </section>
    </SecuritySurface>
  )
}
