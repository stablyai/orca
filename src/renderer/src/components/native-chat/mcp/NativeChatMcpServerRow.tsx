import { useState, type ReactNode } from 'react'
import type {
  AgentSessionMcpOperation,
  AgentSessionMcpServer,
  AgentSessionMcpSignIn
} from '../../../../../shared/agent-session/agent-session-mcp'
import { LoadingSpinner } from '@/components/LoadingSpinner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { mcpServerStatusLine } from './native-chat-mcp-server-text'
import {
  agentSessionMcpRowFailure,
  agentSessionMcpServerDisplayName
} from '../../../../../shared/agent-session/view/agent-session-mcp-server-presentation'
import { useDeferredPending } from './use-deferred-pending'

export type McpServerAction = Exclude<AgentSessionMcpOperation, { action: 'status' }>

const DOT_CLASS: Record<Exclude<AgentSessionMcpServer['status'], 'pending'>, string> = {
  connected: 'bg-status-success',
  'needs-auth': 'bg-status-warning',
  failed: 'bg-destructive',
  disabled: 'bg-muted-foreground/40'
}

/** The label keeps its width while a spinner stands in for it. */
function PendingLabel({ pending, children }: { pending: boolean; children: ReactNode }) {
  const spinning = useDeferredPending(pending)
  return (
    <span className="relative inline-flex items-center justify-center">
      <span className={cn(spinning && 'invisible')}>{children}</span>
      {spinning ? <LoadingSpinner className="absolute size-3" /> : null}
    </span>
  )
}

export function NativeChatMcpServerRow({
  server,
  runtime,
  signIn,
  pending,
  busy,
  failure,
  run,
  dismissSignIn,
  openUrl
}: {
  server: AgentSessionMcpServer
  /** Where the agent runs: only an agent on this computer receives the browser's sign-in callback. */
  runtime: 'local' | 'remote'
  /** This row's sign-in in progress. */
  signIn: AgentSessionMcpSignIn | null
  /** This row's action in flight. */
  pending: McpServerAction | null
  /** Any row's action is in flight; the panel runs one at a time. */
  busy: boolean
  /** The panel's last refused action; a null message has no detail. */
  failure: { server: string; message: string | null } | null
  run: (operation: McpServerAction) => void
  dismissSignIn: () => void
  openUrl: (url: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  const name = server.name
  const refusal = agentSessionMcpRowFailure(server, failure, signIn)
  const enabled = pending?.action === 'toggle' ? pending.enabled : server.status !== 'disabled'
  const statusLine = signIn
    ? signIn.finish === 'callback' && runtime === 'local'
      ? t(
          'components.native-chat.mcp.signIn.waitingBrowser',
          'Waiting for sign-in in your browser…'
        )
      : t('components.native-chat.mcp.signIn.waiting', 'Waiting for sign-in…')
    : mcpServerStatusLine(server, t)
  const action = signIn ? (
    <Button type="button" variant="ghost" size="xs" onClick={dismissSignIn}>
      {t('components.native-chat.mcp.cancel', 'Cancel')}
    </Button>
  ) : server.canSignIn && server.status === 'needs-auth' ? (
    <Button
      type="button"
      size="xs"
      disabled={busy}
      onClick={() => run({ action: 'signIn', server: name })}
    >
      <PendingLabel pending={pending?.action === 'signIn'}>
        {t('components.native-chat.mcp.signIn.action', 'Sign in')}
      </PendingLabel>
    </Button>
  ) : server.canReconnect && server.status === 'failed' ? (
    <Button
      type="button"
      variant="outline"
      size="xs"
      disabled={busy}
      onClick={() => run({ action: 'reconnect', server: name })}
    >
      <PendingLabel pending={pending?.action === 'reconnect'}>
        {t('components.native-chat.mcp.reconnect', 'Reconnect')}
      </PendingLabel>
    </Button>
  ) : null
  return (
    <div className="border-b border-border/60 last:border-b-0">
      <div className="flex items-center gap-2.5 px-3 py-2">
        <span aria-hidden="true" className="flex size-3 shrink-0 items-center justify-center">
          {signIn || server.status === 'pending' ? (
            <LoadingSpinner className="size-3 text-muted-foreground" />
          ) : (
            <span className={cn('size-2 rounded-full', DOT_CLASS[server.status])} />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">
            {agentSessionMcpServerDisplayName(server)}
          </div>
          <div
            className={cn(
              'truncate text-xs',
              server.status === 'failed' && !signIn ? 'text-destructive' : 'text-muted-foreground'
            )}
            title={statusLine}
          >
            {statusLine}
          </div>
        </div>
        {action}
        {server.canToggle && !signIn ? (
          <Switch
            checked={enabled}
            disabled={busy}
            aria-label={t('components.native-chat.mcp.toggle', 'Use {{name}}', { name })}
            onCheckedChange={(checked) => run({ action: 'toggle', server: name, enabled: checked })}
          />
        ) : null}
      </div>
      {signIn ? (
        <McpSignInBox
          key={signIn.url}
          signIn={signIn}
          runtime={runtime}
          pending={pending}
          busy={busy}
          run={run}
          openUrl={openUrl}
        />
      ) : null}
      {refusal ? (
        <div className="-mt-1 pr-3 pb-2 pl-8.5 text-xs text-destructive">
          {refusal.kind === 'signInUnfinished'
            ? t(
                'components.native-chat.mcp.signIn.unfinished',
                'Sign-in isn’t finished yet. Finish it on the page that opened, then press Done.'
              )
            : (refusal.message ??
              t('components.native-chat.mcp.actionFailed', 'Couldn’t do that. Try again.'))}
        </div>
      ) : null}
    </div>
  )
}

function McpSignInBox({
  signIn,
  runtime,
  pending,
  busy,
  run,
  openUrl
}: {
  signIn: AgentSessionMcpSignIn
  runtime: 'local' | 'remote'
  pending: McpServerAction | null
  busy: boolean
  run: (operation: McpServerAction) => void
  openUrl: (url: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [callbackUrl, setCallbackUrl] = useState('')
  const openAgain = (
    <Button type="button" variant="outline" size="xs" onClick={() => openUrl(signIn.url)}>
      {t('components.native-chat.mcp.signIn.openAgain', 'Open again')}
    </Button>
  )
  const box = 'mr-3 mb-2.5 ml-8.5 rounded-md border border-border bg-muted/40 p-2.5 text-xs'
  const hint = 'mb-2 text-muted-foreground'
  if (signIn.finish === 'external') {
    return (
      <div className={box}>
        <p className={hint}>
          {t(
            'components.native-chat.mcp.signIn.external',
            'Finish signing in on the page that opened, then press Done.'
          )}
        </p>
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            size="xs"
            disabled={busy}
            onClick={() => run({ action: 'reconnect', server: signIn.server })}
          >
            <PendingLabel pending={pending?.action === 'reconnect'}>
              {t('components.native-chat.mcp.signIn.done', 'Done')}
            </PendingLabel>
          </Button>
          {openAgain}
        </div>
      </div>
    )
  }
  if (runtime === 'local') {
    return (
      <div className={box}>
        <p className={hint}>
          {t(
            'components.native-chat.mcp.signIn.local',
            'Opened the sign-in page in your browser. This updates when you finish.'
          )}
        </p>
        {openAgain}
      </div>
    )
  }
  const address = callbackUrl.trim()
  return (
    <form
      className={box}
      onSubmit={(event) => {
        event.preventDefault()
        if (address && !busy) {
          run({ action: 'finishSignIn', server: signIn.server, callbackUrl: address })
        }
      }}
    >
      <p className={hint}>
        {t(
          'components.native-chat.mcp.signIn.remote',
          'After you sign in, the browser lands on a page that won’t load. Copy that page’s address and paste it here.'
        )}
      </p>
      <div className="flex items-center gap-1.5">
        <Input
          autoFocus
          variant="code"
          density="compact"
          className="h-6 min-w-0 flex-1"
          value={callbackUrl}
          onChange={(event) => setCallbackUrl(event.target.value)}
          placeholder={t(
            'components.native-chat.mcp.signIn.pastePlaceholder',
            'http://localhost:…'
          )}
          aria-label={t('components.native-chat.mcp.signIn.addressLabel', 'Sign-in page address')}
          spellCheck={false}
          autoComplete="off"
        />
        <Button type="submit" size="xs" disabled={busy || !address}>
          <PendingLabel pending={pending?.action === 'finishSignIn'}>
            {t('components.native-chat.mcp.signIn.finish', 'Finish')}
          </PendingLabel>
        </Button>
        {openAgain}
      </div>
    </form>
  )
}
