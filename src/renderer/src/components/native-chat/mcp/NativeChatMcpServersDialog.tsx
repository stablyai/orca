import { useCallback, useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { LoadingSpinner } from '@/components/LoadingSpinner'
import { useTranslate } from '@/i18n/use-translate'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'
import { callStructuredAgentSession } from '@/runtime/native-chat/requests/structured-agent-session-call'
import type {
  AgentSessionMcpOperation,
  AgentSessionMcpResult
} from '../../../../../shared/agent-session/agent-session-mcp'
import {
  createAgentSessionMcpPanelHook,
  type AgentSessionMcpPanelState
} from '../../../../../shared/agent-session/view/use-agent-session-mcp-panel'
import {
  readNativeChatSessionModalRequest,
  type NativeChatSessionModalRequest
} from '../session/native-chat-session-modal-request'
import { mcpSourceLabel } from './native-chat-mcp-server-text'
import { groupAgentSessionMcpServers } from '../../../../../shared/agent-session/view/agent-session-mcp-server-presentation'
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

/** `/mcp`'s modal: each opening mounts a fresh read of the chat's servers. */
export default function NativeChatMcpServersDialog(): React.JSX.Element | null {
  const modalData = useAppStore((s) => s.modalData)
  // The opening's chat is fixed; a fresh object per render would restart its read.
  const [request] = useState(() => readNativeChatSessionModalRequest(modalData))
  return request ? <McpServersDialog request={request} /> : null
}

function McpServersDialog({
  request
}: {
  request: NativeChatSessionModalRequest
}): React.JSX.Element {
  const closeModal = useAppStore((s) => s.closeModal)
  const { sessionId, target } = request
  const call = useCallback(
    (operation: AgentSessionMcpOperation) =>
      callStructuredAgentSession<AgentSessionMcpResult>(target, 'agentSession.mcp', {
        sessionId,
        operation
      }),
    [sessionId, target]
  )
  const panel = useAgentSessionMcpPanel(call, openSignInPage)
  const readAgain = panel.retry
  const [retrying, setRetrying] = useState(false)
  const retry = useCallback(() => {
    setRetrying(true)
    void readAgain().finally(() => setRetrying(false))
  }, [readAgain])
  return (
    <NativeChatMcpServersDialogView
      state={panel}
      runtime={target.kind === 'local' ? 'local' : 'remote'}
      run={(operation) => void panel.run(operation)}
      retry={retry}
      retrying={retrying}
      dismissSignIn={panel.dismissSignIn}
      openUrl={openSignInPage}
      onClose={closeModal}
    />
  )
}

export function NativeChatMcpServersDialogView({
  onClose,
  ...body
}: McpServersBodyProps & { onClose: () => void }): React.JSX.Element {
  const t = useTranslate()
  // Why: the slot has no trigger element for the dialog to hand focus back to.
  const [returnFocusTo] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null
  )
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        surface="panel"
        className="top-[max(2rem,calc(50%-320px))] flex max-h-[min(640px,calc(100vh-4rem))] translate-y-0 flex-col overflow-hidden sm:max-w-[440px]"
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          if (returnFocusTo?.isConnected) {
            returnFocusTo.focus({ preventScroll: true })
          }
        }}
      >
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-sidebar-border px-3 py-2">
          <DialogTitle size="compact">
            {t('components.native-chat.mcp.title', 'MCP servers')}
          </DialogTitle>
          <DialogClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="size-6"
              aria-label={t('auto.components.ui.dialog.f26c4baeda', 'Close')}
            >
              <X className="size-3" />
            </Button>
          </DialogClose>
        </div>
        <div className="scrollbar-sleek min-h-0 overflow-y-auto">
          <McpServersBody {...body} />
        </div>
      </DialogContent>
    </Dialog>
  )
}

type McpServersBodyProps = {
  state: AgentSessionMcpPanelState
  runtime: 'local' | 'remote'
  run: (operation: McpServerAction) => void
  retry: () => void
  retrying: boolean
  dismissSignIn: () => void
  openUrl: (url: string) => void
}

function McpServersBody({
  state,
  runtime,
  run,
  retry,
  retrying,
  dismissSignIn,
  openUrl
}: McpServersBodyProps): React.JSX.Element {
  const t = useTranslate()
  const loading = useDeferredPending(state.result === null)
  const notice = 'px-3 py-4 text-sm text-muted-foreground'
  if (state.result === null) {
    return (
      <div className={notice} aria-busy="true">
        <span className={loading ? 'flex items-center gap-2' : 'invisible flex'}>
          <LoadingSpinner className="size-4" />
          {t('components.native-chat.mcp.loading', 'Loading MCP servers…')}
        </span>
      </div>
    )
  }
  if (state.result.status === 'not-running') {
    return (
      <div className={notice}>
        {t(
          'components.native-chat.mcp.notRunning',
          'MCP servers connect when you send your next message.'
        )}
      </div>
    )
  }
  if (state.result.status === 'unsupported') {
    return (
      <div className={notice}>
        {t(
          'components.native-chat.mcp.unsupported',
          'Update Orca on this chat’s host to manage MCP servers here.'
        )}
      </div>
    )
  }
  if (state.result.status === 'failed') {
    return (
      <div className={`${notice} flex items-center gap-2`}>
        <span className="min-w-0 flex-1">
          {state.result.message ??
            t(
              'components.native-chat.mcp.readFailed',
              'MCP servers couldn’t be loaded. Try again.'
            )}
        </span>
        <Button type="button" variant="outline" size="xs" disabled={retrying} onClick={retry}>
          {t('components.native-chat.mcp.retry', 'Retry')}
        </Button>
      </div>
    )
  }
  if (state.servers.length === 0) {
    return (
      <div className={notice}>
        {t('components.native-chat.mcp.empty', 'No MCP servers are set up for this chat.')}
      </div>
    )
  }
  const pending = state.pending
  return (
    <div className="pb-1">
      {groupAgentSessionMcpServers(state.servers).map((group) => (
        <div key={group.source ?? ''} className="border-b border-border/60 last:border-b-0">
          {group.source !== null ? (
            <div className="px-3 pt-2 pb-0.5 text-2xs font-semibold tracking-wider text-muted-foreground uppercase">
              {mcpSourceLabel(group.source, t)}
            </div>
          ) : null}
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
        </div>
      ))}
    </div>
  )
}
