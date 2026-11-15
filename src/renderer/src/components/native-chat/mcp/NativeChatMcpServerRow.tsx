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

/** Indents a row's detail under its name, past the status dot. */
const DETAIL_INSET = 'mr-2 mb-1.5 ml-8'

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
    ? signIn.finish === 'external'
      ? t('components.native-chat.mcp.signIn.external', 'Finish on the page that opened')
      : runtime === 'local'
        ? t('components.native-chat.mcp.signIn.waitingBrowser', 'Waiting for your browser…')
        : t('components.native-chat.mcp.signIn.waiting', 'Waiting for sign-in…')
    : mcpServerStatusLine(server, t)
  const cancel = (
    <Button type="button" variant="ghost" size="xs" onClick={dismissSignIn}>
      {t('components.native-chat.mcp.cancel', 'Cancel')}
    </Button>
  )
  const actions = signIn ? (
    <>
      {signIn.finish === 'external' ? (
        // The provider's site finishes it; reconnecting picks the new sign-in up.
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
      ) : (
        <Button type="button" variant="ghost" size="xs" onClick={() => openUrl(signIn.url)}>
          {t('components.native-chat.mcp.signIn.openAgain', 'Open again')}
        </Button>
      )}
      {cancel}
    </>
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
    <li>
      <div className="flex h-8 min-w-0 items-center gap-2 pr-2 pl-3">
        <span aria-hidden="true" className="flex size-3 shrink-0 items-center justify-center">
          {signIn || server.status === 'pending' ? (
            <LoadingSpinner className="size-3 text-muted-foreground" />
          ) : (
            <span className={cn('size-1.75 rounded-full', DOT_CLASS[server.status])} />
          )}
        </span>
        <span className="max-w-1/2 shrink-0 truncate font-medium text-foreground">
          {agentSessionMcpServerDisplayName(server)}
        </span>
        <span
          className={cn(
            'min-w-0 flex-1 truncate',
            server.status === 'failed' && !signIn ? 'text-destructive' : 'text-muted-foreground'
          )}
          title={statusLine}
        >
          {statusLine}
        </span>
        {actions}
        {server.canToggle && !signIn ? (
          <Switch
            size="compact"
            checked={enabled}
            disabled={busy}
            aria-label={t('components.native-chat.mcp.toggle', 'Use {{name}}', { name })}
            onCheckedChange={(checked) => run({ action: 'toggle', server: name, enabled: checked })}
          />
        ) : null}
      </div>
      {signIn?.finish === 'callback' && runtime === 'remote' ? (
        <McpSignInAddressBox
          key={signIn.url}
          signIn={signIn}
          pending={pending}
          busy={busy}
          run={run}
        />
      ) : null}
      {refusal ? (
        <p className={cn(DETAIL_INSET, '-mt-1 text-destructive')}>
          {refusal.kind === 'signInUnfinished'
            ? t(
                'components.native-chat.mcp.signIn.unfinished',
                'Sign-in isn’t finished yet. Finish it on the page that opened, then press Done.'
              )
            : (refusal.message ??
              t('components.native-chat.mcp.actionFailed', 'Couldn’t do that. Try again.'))}
        </p>
      ) : null}
    </li>
  )
}

/** A browser on another device can't reach the agent's callback; the user pastes where it landed. */
function McpSignInAddressBox({
  signIn,
  pending,
  busy,
  run
}: {
  signIn: AgentSessionMcpSignIn
  pending: McpServerAction | null
  busy: boolean
  run: (operation: McpServerAction) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [callbackUrl, setCallbackUrl] = useState('')
  const address = callbackUrl.trim()
  return (
    <form
      className={cn(DETAIL_INSET, 'rounded-md border border-border bg-background p-2')}
      onSubmit={(event) => {
        event.preventDefault()
        if (address && !busy) {
          run({ action: 'finishSignIn', server: signIn.server, callbackUrl: address })
        }
      }}
    >
      <p className="mb-1.5 text-muted-foreground">
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
      </div>
    </form>
  )
}
