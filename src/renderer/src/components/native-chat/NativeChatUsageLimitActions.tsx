import {
  createContext,
  useContext,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { MessageSquarePlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { structuredChatTabById } from '@/lib/structured-chat-tab-index'
import { useStructuredChatTabConversationName } from '@/runtime/structured-conversation-name'
import { AgentSessionContinuationDialog } from '@/components/agent-session-continuation/AgentSessionContinuationDialog'
import {
  buildAgentSessionContinuationPrompt,
  type AgentSessionContinuationRequest
} from '@/lib/agent-session-continuation'
import { ClaudeSwitcherMenu } from '@/components/status-bar/ClaudeSwitcherMenu'
import { ProviderAccountChatButton } from '@/components/status-bar/ProviderAccountChatButton'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import type { AgentSessionOptionsResult } from '../../../../shared/agent-session/options/agent-session-options-result'
import { executionHostIdForStructuredTarget } from '@/runtime/structured-agent-session-owner'
import {
  NativeChatOrcaStopContext,
  type NativeChatOrcaStopView
} from './native-chat-orca-stop-context'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import type { NativeChatStructuredViewProps } from './native-chat-view-types'
import type { NativeChatFileLinkContext } from './native-chat-file-link'
import { nativeChatMessageCopyText } from '../../../../shared/native-chat-message-copy-text'

type UsageLimitActions = {
  account: ReactNode
  handOff?: () => void
  disabled: boolean
}
const UsageLimitActionsContext = createContext<UsageLimitActions | null>(null)

export function NativeChatUsageLimitActionsProvider({
  pane,
  directory,
  messages,
  view,
  recovery,
  children
}: {
  pane: Omit<NativeChatStructuredViewProps, 'mode'>
  directory: NativeChatFileLinkContext | null
  messages: readonly NativeChatMessage[]
  view: NativeChatOrcaStopView
  recovery: {
    readCurrent: boolean
    canSwitchAccount: boolean | undefined
    epoch?: string | null
  }
  children: ReactNode
}): React.JSX.Element {
  const loading = !recovery.readCurrent
  const canSwitchAccount = recovery.canSwitchAccount
  const active = view.usageLimitTurnItemId !== null
  const intentKey = JSON.stringify([
    executionHostIdForStructuredTarget(pane.target),
    pane.sessionId,
    pane.agent,
    recovery.epoch,
    view.usageLimitTurnItemId,
    recovery.readCurrent,
    pane.isVisible
  ])
  const intent = useRef<{ key: string; pending: boolean } | null>(null)
  const [preparing, setPreparing] = useState<string | null>(null)
  useLayoutEffect(() => {
    const current = { key: intentKey, pending: false }
    intent.current = current
    setPreparing(null)
    return () => {
      if (intent.current === current) {
        intent.current = null
      }
    }
  }, [intentKey])
  const disabled = loading || preparing === intentKey
  const chatTab = useAppStore((state) =>
    directory
      ? structuredChatTabById(state.unifiedTabsByWorktree, directory.worktreeId, pane.tabId)
      : undefined
  )
  const conversationName = useStructuredChatTabConversationName(chatTab)
  const [prepared, setPrepared] = useState<{
    key: string
    request: AgentSessionContinuationRequest
  } | null>(null)
  const request = prepared?.key === intentKey ? prepared.request : null
  const canHandOff =
    active &&
    pane.isVisible &&
    directory &&
    isTuiAgent(pane.agent) &&
    directory.runtimeEnvironmentId ===
      (pane.target.kind === 'environment' ? pane.target.environmentId : null)
  let account: ReactNode = null
  if (pane.agent === 'claude' && active && pane.isVisible) {
    if (canSwitchAccount === undefined) {
      account = <ProviderAccountChatButton provider="claude" target={pane.target} disabled />
    } else if (canSwitchAccount) {
      account = (
        <ClaudeSwitcherMenu
          key={executionHostIdForStructuredTarget(pane.target)}
          claude={null}
          compact
          iconOnly
          chatAction={{
            target: pane.target,
            canSwitch: async () => {
              const current = intent.current
              if (!current || !active) {
                return false
              }
              const result = await callStructuredAgentSession<AgentSessionOptionsResult>(
                pane.target,
                'agentSession.options',
                { sessionId: pane.sessionId }
              )
              return intent.current === current && result.canSwitchAccount === true
            }
          }}
        />
      )
    }
  }
  const openHandOff = useCallback(async (): Promise<void> => {
    if (!canHandOff || !directory || !isTuiAgent(pane.agent)) {
      return
    }
    const current = intent.current
    if (!current || current.pending) {
      return
    }
    current.pending = true
    setPreparing(current.key)
    const options = await callStructuredAgentSession<AgentSessionOptionsResult>(
      pane.target,
      'agentSession.options',
      { sessionId: pane.sessionId }
    ).catch((error: unknown) => {
      console.warn('Could not read saved chat context for hand-off', error)
      return null
    })
    if (intent.current !== current) {
      return
    }
    setPreparing(null)
    const transcriptPath = options?.transcriptPath
    const source = {
      sourceKind: 'chat' as const,
      sourceAgent: pane.agent,
      sourceTitle: chatTab?.customLabel?.trim() || conversationName || chatTab?.label,
      sourceWorkingDirectory: directory.worktreePath,
      transcriptPath,
      capturedText: transcriptPath
        ? ''
        : messages
            .map((message) => `${message.role}: ${nativeChatMessageCopyText(message)}`)
            .join('\n\n')
    }
    if (buildAgentSessionContinuationPrompt(source, 'focused')) {
      setPrepared({
        key: current.key,
        request: {
          source,
          worktreeId: directory.worktreeId,
          workspacePath: directory.worktreePath,
          initialCwd: directory.worktreePath,
          groupId: pane.groupId,
          launchSource: 'native_chat',
          avoidSourceAgent: true
        }
      })
    } else {
      current.pending = false
    }
  }, [
    canHandOff,
    directory,
    pane.agent,
    pane.groupId,
    pane.sessionId,
    pane.target,
    chatTab,
    conversationName,
    messages
  ])
  const actions = useMemo<UsageLimitActions>(
    () => ({
      account,
      disabled,
      ...(canHandOff || (loading && isTuiAgent(pane.agent))
        ? {
            handOff: () => {
              void openHandOff()
            }
          }
        : {})
    }),
    [account, canHandOff, disabled, loading, openHandOff, pane.agent]
  )
  const stopView = useMemo(
    () => ({
      ...view,
      continueUsageLimit: (hadFocus?: boolean) => {
        intent.current = { key: intentKey, pending: false }
        setPreparing(null)
        setPrepared(null)
        view.continueUsageLimit(hadFocus)
      }
    }),
    [intentKey, view]
  )
  return (
    <UsageLimitActionsContext.Provider value={actions}>
      <NativeChatOrcaStopContext.Provider value={stopView}>
        {children}
      </NativeChatOrcaStopContext.Provider>
      {request ? (
        <AgentSessionContinuationDialog
          open
          request={request}
          onOpenChange={(open) => {
            if (!open) {
              intent.current = { key: intentKey, pending: false }
              setPrepared(null)
            }
          }}
        />
      ) : null}
    </UsageLimitActionsContext.Provider>
  )
}

export function NativeChatUsageLimitActions(): React.JSX.Element | null {
  const actions = useContext(UsageLimitActionsContext)
  if (!actions || (!actions.account && !actions.handOff)) {
    return null
  }
  return (
    <div className="ml-6 flex flex-wrap items-center gap-2 text-chat-foreground-faint">
      <p className="text-xs">
        {translate(
          'components.native-chat.usageLimitActions.leadIn',
          'Continue this chat without waiting:'
        )}
      </p>
      {actions.account ? <div className="w-32 shrink-0 empty:hidden">{actions.account}</div> : null}
      {actions.handOff ? (
        <Button
          type="button"
          variant="outline"
          size="xs"
          disabled={actions.disabled}
          onClick={actions.handOff}
        >
          <MessageSquarePlus />
          {translate(
            'components.agentSessionContinuation.handOffToAnotherAgent',
            'Hand Off to Another Agent'
          )}
        </Button>
      ) : null}
    </div>
  )
}
