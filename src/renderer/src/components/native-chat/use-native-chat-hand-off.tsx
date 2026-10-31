import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { withTimeout } from '../../../../shared/promise-timeout-fallback'
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useAppStore } from '@/store'
import { structuredChatTabById } from '@/lib/structured-chat-tab-index'
import { useStructuredChatTabConversationName } from '@/runtime/structured-conversation-name'
import { AgentSessionContinuationDialog } from '@/components/agent-session-continuation/AgentSessionContinuationDialog'
import {
  buildAgentSessionContinuationPrompt,
  type AgentSessionContinuationRequest
} from '@/lib/agent-session-continuation'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import {
  callStructuredAgentSession,
  supportsStructuredAgentSessionContinuationContext
} from '@/runtime/structured-agent-session-client'
import type { AgentSessionContinuationContext } from '../../../../shared/agent-session-wire'
import { executionHostIdForStructuredTarget } from '@/runtime/structured-agent-session-owner'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { NativeChatStructuredViewProps } from './native-chat-view-types'
import type { NativeChatFileLinkContext } from './native-chat-file-link'
import { nativeChatMessageCopyText } from '../../../../shared/native-chat-message-copy-text'

export type NativeChatHandOff = {
  /** This chat can seed another agent from its owning workspace. */
  available: boolean
  preparing: boolean
  open: () => void
  /** Drops a pending or open hand-off, e.g. when the conversation it describes moves on. */
  reset: () => void
  dialog: ReactNode
}

export function useNativeChatHandOff({
  pane,
  directory,
  messages,
  epoch,
  focusComposer
}: {
  pane: Pick<
    NativeChatStructuredViewProps,
    'tabId' | 'groupId' | 'sessionId' | 'target' | 'agent' | 'isVisible'
  >
  directory: NativeChatFileLinkContext | null
  messages: readonly NativeChatMessage[]
  epoch: string | null
  focusComposer: () => void
}): NativeChatHandOff {
  const intentKey = JSON.stringify([
    executionHostIdForStructuredTarget(pane.target),
    pane.sessionId,
    pane.agent,
    pane.isVisible,
    epoch,
    directory
  ])
  const operationSerial = useRef(0)
  type Attempt = { key: string; operation: number } & (
    | { phase: 'preparing' }
    | { phase: 'prepared'; request: AgentSessionContinuationRequest }
  )
  const active = useRef<Attempt | null>(null)
  const [attempt, setAttempt] = useState<Attempt | null>(null)
  const retire = useCallback(() => {
    active.current = null
    setAttempt(null)
  }, [])
  useLayoutEffect(() => {
    retire()
    return () => {
      retire()
    }
  }, [intentKey, retire])
  const chatTab = useAppStore((state) =>
    directory
      ? structuredChatTabById(state.unifiedTabsByWorktree, directory.worktreeId, pane.tabId)
      : undefined
  )
  const conversationName = useStructuredChatTabConversationName(chatTab)
  const currentAttempt = attempt === active.current && attempt?.key === intentKey ? attempt : null
  const request = currentAttempt?.phase === 'prepared' ? currentAttempt.request : null
  // The dialog launches in the chat's workspace, so it must be the same host the chat runs on.
  const available = Boolean(
    pane.isVisible &&
    epoch &&
    directory &&
    isTuiAgent(pane.agent) &&
    directory.runtimeEnvironmentId ===
      (pane.target.kind === 'environment' ? pane.target.environmentId : null)
  )
  const prepare = useCallback(async (): Promise<void> => {
    if (!available || !directory || !epoch || !isTuiAgent(pane.agent)) {
      return
    }
    if (active.current) {
      return
    }
    const current: Attempt = {
      key: intentKey,
      operation: ++operationSerial.current,
      phase: 'preparing'
    }
    active.current = current
    setAttempt(current)
    const context = await withTimeout(
      (async () => {
        if (
          !(await supportsStructuredAgentSessionContinuationContext(pane.target)) ||
          active.current !== current ||
          current.phase !== 'preparing'
        ) {
          return null
        }
        return callStructuredAgentSession<AgentSessionContinuationContext>(
          pane.target,
          'agentSession.continuationContext',
          {
            sessionId: pane.sessionId,
            workspaceId: directory.worktreeId,
            expectedCursor: { epoch, sequence: 0 }
          }
        )
      })(),
      30_000,
      null
    )
    if (active.current !== current || current.phase !== 'preparing') {
      return
    }
    if (context?.status === 'superseded') {
      retire()
      return
    }
    const saved = context?.status === 'current' && typeof context.capturedText === 'string'
    const transcriptPath = saved ? context.transcriptPath : undefined
    const source = {
      sourceKind: 'chat' as const,
      sourceAgent: pane.agent,
      sourceTitle: chatTab?.customLabel?.trim() || conversationName || chatTab?.label,
      sourceWorkingDirectory: directory.worktreePath,
      transcriptPath,
      capturedText: saved
        ? (context.capturedText ?? '')
        : messages
            .flatMap((message) => {
              if (message.agentStart) {
                return []
              }
              const text = nativeChatMessageCopyText(message).trim()
              return text ? [`${message.role}: ${text}`] : []
            })
            .join('\n\n')
    }
    if (buildAgentSessionContinuationPrompt(source, 'focused')) {
      const prepared: Attempt = {
        ...current,
        phase: 'prepared',
        request: {
          source,
          worktreeId: directory.worktreeId,
          workspacePath: directory.worktreePath,
          initialCwd: directory.worktreePath,
          groupId: pane.groupId,
          launchSource: 'native_chat'
        }
      }
      active.current = prepared
      setAttempt(prepared)
    } else {
      retire()
      toast.error(
        translate(
          'components.agentSessionContinuation.noContext',
          'No session context is available to continue in a new session.'
        )
      )
      focusComposer()
    }
  }, [
    available,
    intentKey,
    retire,
    epoch,
    focusComposer,
    directory,
    pane.agent,
    pane.groupId,
    pane.sessionId,
    pane.target,
    chatTab,
    conversationName,
    messages
  ])
  const open = useCallback(() => {
    void prepare()
  }, [prepare])
  return {
    available,
    preparing: currentAttempt?.phase === 'preparing',
    open,
    reset: retire,
    dialog: currentAttempt ? (
      <AgentSessionContinuationDialog
        key={currentAttempt.operation}
        open
        request={request}
        sourceWorkingDirectory={directory?.worktreePath}
        onOpenChange={(isOpen) => {
          if (!isOpen && active.current === currentAttempt) {
            retire()
          }
        }}
      />
    ) : null
  }
}
