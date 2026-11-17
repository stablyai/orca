import { useCallback, useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
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
  AgentSessionMcpResult
} from '../../../../../shared/agent-session/options/protocol/agent-session-mcp'
import {
  createAgentSessionMcpPanelHook,
  type AgentSessionMcpPanelState
} from '../../../../../shared/agent-session/view/use-agent-session-mcp-panel'
import { groupAgentSessionMcpServers } from '../../../../../shared/agent-session/view/agent-session-mcp-server-presentation'
import { NativeChatComposerTabStrip } from '../composer/controls/NativeChatComposerTabStrip'
import { useStructuredAgentSessionHostExecutionPhase } from '../session/status/structured-agent-session-status-hooks'
import { mcpSourceLabel, mcpTraySummary } from './native-chat-mcp-server-text'
import { NativeChatMcpServerRow, type McpServerAction } from './NativeChatMcpServerRow'
import { useDeferredPending } from './use-deferred-pending'

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
  opens,
  onClose
}: {
  sessionId: string
  target: RuntimeClientTarget
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
  const panel = useAgentSessionMcpPanel(call, openSignInPage, `${opens}:${phase}`)
  const readAgain = panel.retry
  const [retrying, setRetrying] = useState(false)
  const retry = useCallback(() => {
    setRetrying(true)
    void readAgain().finally(() => setRetrying(false))
  }, [readAgain])
  return (
    <NativeChatMcpTrayView
      state={panel}
      runtime={target.kind === 'local' ? 'local' : 'remote'}
      run={(operation) => void panel.run(operation)}
      retry={retry}
      retrying={retrying}
      dismissSignIn={panel.dismissSignIn}
      openUrl={openSignInPage}
      onClose={onClose}
    />
  )
}

type McpTrayViewProps = {
  state: AgentSessionMcpPanelState
  runtime: 'local' | 'remote'
  run: (operation: McpServerAction) => void
  retry: () => void
  retrying: boolean
  dismissSignIn: () => void
  openUrl: (url: string) => void
  onClose: () => void
}

export function NativeChatMcpTrayView(props: McpTrayViewProps): React.JSX.Element {
  const t = useTranslate()
  const title = t('components.native-chat.mcp.title', 'MCP servers')
  const closeLabel = t('components.native-chat.mcp.close', 'Close')
  const listed = props.state.result?.status === 'ok' && props.state.servers.length > 0
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
        {listed ? <McpTrayList {...props} /> : null}
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
        <LoadingSpinner className="mr-1 inline size-3 align-[-0.125em]" />
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
  runtime,
  run,
  dismissSignIn,
  openUrl
}: McpTrayViewProps): React.JSX.Element {
  const t = useTranslate()
  const pending = state.pending
  return (
    <div className="scrollbar-sleek max-h-52 overflow-y-auto border-t border-border py-1">
      {groupAgentSessionMcpServers(state.servers).map((group) => {
        const label = group.source === null ? undefined : mcpSourceLabel(group.source, t)
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
                  signIn={state.signIn?.server === server.name ? state.signIn : null}
                  pending={pending?.server === server.name ? pending : null}
                  busy={pending !== null}
                  failure={state.failure}
                  run={run}
                  dismissSignIn={dismissSignIn}
                  openUrl={openUrl}
                />
              ))}
            </ul>
          </div>
        )
      })}
    </div>
  )
}
