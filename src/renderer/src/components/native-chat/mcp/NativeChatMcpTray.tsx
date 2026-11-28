import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUpRight, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'
import { callStructuredAgentSession } from '@/runtime/native-chat/requests/structured-agent-session-call'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type {
  AgentSessionMcpOperation,
  AgentSessionMcpResult,
  AgentSessionMcpServer
} from '../../../../../shared/agent-session/options/protocol/agent-session-mcp'
import {
  createAgentSessionMcpPanelHook,
  type AgentSessionMcpPanelState
} from '../../../../../shared/agent-session/view/use-agent-session-mcp-panel'
import {
  groupAgentSessionMcpServers,
  uncheckedOrcaMcpServerIds,
  ORCA_MCP_SOURCE,
  withOrcaMcpProblems
} from '../../../../../shared/agent-session/view/agent-session-mcp-server-presentation'
import { MCP_SERVERS_RUNTIME_CAPABILITY } from '../../../../../shared/mcp-servers/mcp-servers'
import { useStructuredAgentSessionHostCapability } from '@/runtime/native-chat/host-capabilities/structured-agent-session-host-capability'
import { openMcpServersSettings } from '@/components/settings/navigation/open-mcp-servers-settings'
import {
  McpServerSignInDialog,
  type McpSignInServer
} from '@/components/settings/mcp-servers/McpServerSignInDialog'
import { useSettingsHostLabel } from '@/components/settings/host-scope/use-host-setting'
import { NativeChatComposerTabStrip } from '../composer/controls/NativeChatComposerTabStrip'
import { useStructuredAgentSessionHostExecutionPhase } from '../session/status/structured-agent-session-status-hooks'
import { mcpSourceLabel, mcpTraySummary } from './native-chat-mcp-server-text'
import { NativeChatMcpServerRow, type McpServerAction } from './NativeChatMcpServerRow'
import { useDeferredPending } from './use-deferred-pending'
import { useOrcaMcpProblems } from './use-orca-mcp-problems'

const useAgentSessionMcpPanel = createAgentSessionMcpPanelHook({
  useCallback,
  useEffect,
  useRef,
  useState
})

// Sign-in belongs in the user's browser, where their accounts are.
const openSignInPage = (url: string): void => {
  openAppHttpLink(url, { destination: 'system' })
}

/** `/mcp`'s tray on the composer's top edge; each opening mounts a fresh read of the chat's servers. */
export function NativeChatMcpTray({
  sessionId,
  target,
  agent,
  agentLabel,
  opens,
  onClose
}: {
  sessionId: string
  target: RuntimeClientTarget
  agent: string
  agentLabel: string
  opens: number
  onClose: () => void
}): React.JSX.Element {
  const call = useCallback(
    (operation: AgentSessionMcpOperation) =>
      callStructuredAgentSession<AgentSessionMcpResult>(target, 'agentSession.mcp', {
        sessionId,
        operation
      }),
    [sessionId, target]
  )
  // An agent at rest has no servers to list; re-read once it starts or stops.
  const phase = useStructuredAgentSessionHostExecutionPhase(sessionId, target)
  // Only a host whose MCP servers are on has a settings page for them.
  const managed = useStructuredAgentSessionHostCapability(target, MCP_SERVERS_RUNTIME_CAPABILITY)
  const panel = useAgentSessionMcpPanel(call, openSignInPage, `${opens}:${phase}`, {
    reconnectFeedback: managed
  })
  const readAgain = panel.retry
  const [retrying, setRetrying] = useState(false)
  const retry = useCallback(() => {
    setRetrying(true)
    void readAgain().finally(() => setRetrying(false))
  }, [readAgain])
  // Before the agent starts, Orca checks its own servers and signs in to them itself.
  const problems = useOrcaMcpProblems(
    target,
    agent,
    managed ? uncheckedOrcaMcpServerIds(panel.servers) : ''
  )
  const servers = useMemo(
    () => withOrcaMcpProblems(panel.servers, problems, agent),
    [agent, panel.servers, problems]
  )
  const hostName = useSettingsHostLabel(target)
  const [signingIn, setSigningIn] = useState<McpSignInServer | null>(null)
  const signInWithOrca = useCallback((server: AgentSessionMcpServer) => {
    if (server.orca?.url) {
      setSigningIn({ id: server.orca.id, name: server.name, detail: server.orca.url })
    }
  }, [])
  return (
    <>
      <NativeChatMcpTrayView
        state={servers === panel.servers ? panel : { ...panel, servers }}
        hostName={hostName}
        signInWithOrca={signInWithOrca}
        agentLabel={agentLabel}
        runtime={target.kind === 'local' ? 'local' : 'remote'}
        run={(operation) => void panel.run(operation)}
        retry={retry}
        retrying={retrying}
        dismissSignIn={panel.dismissSignIn}
        openUrl={openSignInPage}
        onClose={onClose}
        {...(managed ? { manageServers: () => openMcpServersSettings(target) } : {})}
      />
      <McpServerSignInDialog
        target={target}
        hostName={hostName}
        server={signingIn}
        onClose={() => {
          setSigningIn(null)
          void readAgain()
        }}
      />
    </>
  )
}

type McpTrayViewProps = {
  state: AgentSessionMcpPanelState
  agentLabel: string
  runtime: 'local' | 'remote'
  /** The chat's host, as a command that won't start names it. */
  hostName?: string
  /** Opens Orca's own sign-in to a server it signs in to itself. */
  signInWithOrca?: (server: AgentSessionMcpServer) => void
  run: (operation: McpServerAction) => void
  retry: () => void
  retrying: boolean
  dismissSignIn: () => void
  openUrl: (url: string) => void
  onClose: () => void
  /** Opens the host's MCP servers settings; absent on a host without them. */
  manageServers?: () => void
}

export function NativeChatMcpTrayView(props: McpTrayViewProps): React.JSX.Element {
  const t = useTranslate()
  const title = t('components.native-chat.mcp.title', 'MCP servers')
  const closeLabel = t('components.native-chat.mcp.close', 'Close')
  // An agent at rest lists what its next start gets under the line saying it isn't running.
  const listed = props.state.result !== null && props.state.servers.length > 0
  return (
    <NativeChatComposerTabStrip layout="stack" data-native-chat-mcp-tray="">
      <section
        aria-label={title}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing) {
            return
          }
          event.preventDefault()
          event.stopPropagation()
          props.onClose()
        }}
      >
        <div className="flex h-8 items-center gap-2 pr-1 pl-3">
          <p className="min-w-0 flex-1 truncate" aria-live="polite">
            <span className="font-medium text-foreground">{title}</span>
            <McpTrayStatus {...props} />
          </p>
          {props.state.result?.status === 'failed' ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={props.retrying}
              onClick={props.retry}
            >
              {t('components.native-chat.mcp.retry', 'Retry')}
            </Button>
          ) : null}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={closeLabel}
                onClick={props.onClose}
              >
                <X className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {closeLabel}
            </TooltipContent>
          </Tooltip>
        </div>
        {listed && props.state.servers.some((server) => server.status === 'unreported') ? (
          <p className="border-t border-border px-3 py-1.5 text-muted-foreground">
            {t(
              'components.native-chat.mcp.unreported',
              '{{agent}} doesn’t report connection status',
              { agent: props.agentLabel }
            )}
          </p>
        ) : null}
        {listed ? <McpTrayList {...props} /> : null}
        {props.manageServers ? (
          <div className="flex h-8 items-center border-t border-border px-3">
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              onClick={props.manageServers}
            >
              {t('components.native-chat.mcp.manage', 'Manage MCP servers')}
              <ArrowUpRight className="size-3" aria-hidden />
            </button>
          </div>
        ) : null}
      </section>
    </NativeChatComposerTabStrip>
  )
}

const SEPARATOR = ' · '

/** The header's words after the title: the counts, or the one line a panel-level state needs. */
function McpTrayStatus({ state }: McpTrayViewProps): React.JSX.Element | null {
  const t = useTranslate()
  const loading = useDeferredPending(state.result === null)
  if (state.result === null) {
    return loading ? (
      <span aria-busy="true">
        {SEPARATOR}
        <LoadingSpinner className="mr-1 inline-block size-3 align-[-0.125em]" />
        {t('components.native-chat.mcp.loading', 'Loading…')}
      </span>
    ) : null
  }
  const line =
    state.result.status === 'not-running'
      ? t('components.native-chat.mcp.notRunning', 'Connect when you send your next message')
      : state.result.status === 'unsupported'
        ? t(
            'components.native-chat.mcp.unsupported',
            'Update Orca on this chat’s host to manage them here'
          )
        : state.result.status === 'failed'
          ? (state.result.message ?? t('components.native-chat.mcp.readFailed', 'Couldn’t load'))
          : state.servers.length === 0
            ? t('components.native-chat.mcp.empty', 'None set up for this chat')
            : null
  if (line !== null) {
    return (
      <span title={line}>
        {SEPARATOR}
        {line}
      </span>
    )
  }
  return (
    <>
      {mcpTraySummary(state.servers, state.signIn, t).map((part) => (
        <span key={part.text} className={cn(part.tone === 'warning' && 'text-chat-warning')}>
          <span className="text-muted-foreground">{SEPARATOR}</span>
          {part.text}
        </span>
      ))}
    </>
  )
}

function McpTrayList({
  state,
  agentLabel,
  runtime,
  hostName,
  signInWithOrca,
  run,
  dismissSignIn,
  openUrl
}: McpTrayViewProps): React.JSX.Element {
  const t = useTranslate()
  const pending = state.pending
  const groups = groupAgentSessionMcpServers(state.servers)
  // Orca's group sits above the agent's own, so the list grows to keep them in view.
  const tall = groups.some((group) => group.source === ORCA_MCP_SOURCE)
  return (
    <div
      className={cn(
        'scrollbar-sleek overflow-y-auto border-t border-border py-1',
        tall ? 'max-h-80' : 'max-h-52'
      )}
    >
      {groups.map((group) => {
        // Servers the agent reports no source for are its own; under Orca's, say whose.
        const label =
          group.source !== null ? mcpSourceLabel(group.source, t) : tall ? agentLabel : undefined
        return (
          <div key={group.source ?? ''}>
            {label ? (
              <p className="px-3 pt-1.5 pb-0.5 font-mono text-3xs uppercase tracking-wider text-muted-foreground">
                {label}
              </p>
            ) : null}
            <ul role="list" aria-label={label}>
              {group.servers.map((server) => (
                <NativeChatMcpServerRow
                  key={server.name}
                  server={server}
                  runtime={runtime}
                  hostName={hostName}
                  {...(signInWithOrca && server.orca?.signsIn
                    ? { signInWithOrca: () => signInWithOrca(server) }
                    : {})}
                  signIn={state.signIn?.server === server.name ? state.signIn : null}
                  pending={pending?.server === server.name ? pending : null}
                  busy={pending !== null}
                  failure={state.failure}
                  run={run}
                  dismissSignIn={dismissSignIn}
                  openUrl={openUrl}
                  atRest={state.result?.status === 'not-running'}
                />
              ))}
            </ul>
          </div>
        )
      })}
    </div>
  )
}
