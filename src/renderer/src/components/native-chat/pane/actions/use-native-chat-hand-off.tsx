import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { withTimeout } from '../../../../../../shared/concurrency/promise-timeout-fallback'
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useAppStore } from '@/store/index'
import { structuredChatTabById } from '@/lib/agent-session/tab-identity/structured-chat-tab-index'
import { useStructuredChatTabConversationName } from '@/runtime/native-chat/naming/structured-conversation-name'
import { AgentSessionContinuationDialog } from '@/components/agent-session-continuation/AgentSessionContinuationDialog'
import { buildAgentSessionContinuationPrompt } from '../../../../../../shared/agent-session/conversation-context/agent-session-continuation'
import type { AgentSessionContinuationRequest } from '../../../../../../shared/agent-session/conversation-context/agent-session-continuation'
import { isTuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent-config'
import { callStructuredAgentSession } from '@/runtime/native-chat/requests/structured-agent-session-call'
import { supportsStructuredAgentSessionContinuationContext } from '@/runtime/native-chat/host-capabilities/structured-agent-session-host-support'
import { executionHostIdForStructuredTarget } from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import { buildAgentSessionHandoffContext } from '../../../../../../shared/native-chat/transcript/agent-session-handoff-context'
import { sliceNativeChatMessagesThrough } from '../../../../../../shared/native-chat/transcript/turns/native-chat-hand-off-offer'
import {
  agentSessionContextFloorSequence,
  latestAgentSessionContextClearSequence
} from '../../../../../../shared/agent-session/conversation-context/agent-session-context-clear'
import type { AgentJournalCursor } from '../../../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalRenderItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionContinuationContext } from '../../../../../../shared/agent-session/agent-session-wire'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import type { NativeChatStructuredViewProps } from '../../native-chat-view-types'
import type { NativeChatFileLinkContext } from '../../links/actions/native-chat-file-link-context'
import type {
  NativeChatHandOffRowAction,
  NativeChatHandOffSurface
} from '../../messages/actions/native-chat-hand-off-context'

export type NativeChatHandOff = {
  /** This chat can seed another agent from its owning workspace. */
  available: boolean
  preparing: boolean
  open: () => void
  /** Opens hand-off using only messages from the current context floor through `messageId`. */
  openFromResponse: (messageId: string) => void
  /** Row-level surface shared with transcript rows that do not offer native Fork. */
  rowSurface: NativeChatHandOffSurface | undefined
  /** Drops a pending or open hand-off, e.g. when the conversation it describes moves on. */
  reset: () => void
  dialog: ReactNode
}

export function useNativeChatHandOff(
  pane: Pick<
    NativeChatStructuredViewProps,
    'tabId' | 'groupId' | 'sessionId' | 'target' | 'agent' | 'isVisible'
  >,
  directory: NativeChatFileLinkContext | null,
  chat: {
    messages: readonly NativeChatMessage[]
    journalItems?: readonly AgentJournalRenderItem[]
    contextFloor?: AgentJournalCursor | undefined
    epoch: string | null
  },
  focusComposer: () => void
): NativeChatHandOff {
  const { messages, journalItems, contextFloor, epoch } = chat
  const contextFloorSequence = useMemo(
    () =>
      Math.max(
        journalItems ? latestAgentSessionContextClearSequence(journalItems) : 0,
        agentSessionContextFloorSequence(contextFloor, epoch)
      ),
    [journalItems, contextFloor, epoch]
  )
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
      // The folder the chat runs in, which its transcript's relative paths name.
      sourceWorkingDirectory: directory.pathBase ?? directory.worktreePath,
      transcriptPath,
      capturedText: saved ? (context.capturedText ?? '') : buildAgentSessionHandoffContext(messages)
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
  const latestRef = useRef({
    available,
    intentKey,
    directory,
    epoch,
    pane,
    chatTab,
    conversationName,
    messages,
    contextFloorSequence,
    focusComposer
  })
  useLayoutEffect(() => {
    latestRef.current = {
      available,
      intentKey,
      directory,
      epoch,
      pane,
      chatTab,
      conversationName,
      messages,
      contextFloorSequence,
      focusComposer
    }
  })
  const open = useCallback(() => {
    void prepare()
  }, [prepare])
  const openFromResponse = useCallback(
    (messageId: string): void => {
      const currentEnv = latestRef.current
      if (
        !currentEnv.available ||
        !currentEnv.directory ||
        !currentEnv.epoch ||
        !isTuiAgent(currentEnv.pane.agent) ||
        active.current
      ) {
        return
      }
      const sliced = sliceNativeChatMessagesThrough(
        currentEnv.messages,
        messageId,
        currentEnv.contextFloorSequence
      )
      // Omit the full-session transcriptPath so the new agent cannot read turns after `messageId`.
      const source = {
        sourceKind: 'chat' as const,
        sourceAgent: currentEnv.pane.agent,
        sourceTitle:
          currentEnv.chatTab?.customLabel?.trim() ||
          currentEnv.conversationName ||
          currentEnv.chatTab?.label,
        sourceWorkingDirectory: currentEnv.directory.pathBase ?? currentEnv.directory.worktreePath,
        transcriptPath: undefined,
        capturedText: sliced ? buildAgentSessionHandoffContext(sliced) : '',
        truncatedToResponse: true
      }
      if (buildAgentSessionContinuationPrompt(source, 'focused')) {
        const prepared: Attempt = {
          key: currentEnv.intentKey,
          operation: ++operationSerial.current,
          phase: 'prepared',
          request: {
            source,
            worktreeId: currentEnv.directory.worktreeId,
            workspacePath: currentEnv.directory.worktreePath,
            initialCwd: currentEnv.directory.worktreePath,
            groupId: currentEnv.pane.groupId,
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
        currentEnv.focusComposer()
      }
    },
    [retire]
  )
  const rowAction = useMemo<NativeChatHandOffRowAction>(
    () => ({ openFromResponse }),
    [openFromResponse]
  )
  const rowSurface = useMemo<NativeChatHandOffSurface | undefined>(
    () =>
      available
        ? {
            openFromResponse,
            contextFloorSequence,
            rowAction
          }
        : undefined,
    [available, contextFloorSequence, openFromResponse, rowAction]
  )
  return {
    available,
    preparing: currentAttempt?.phase === 'preparing',
    open,
    openFromResponse,
    rowSurface,
    reset: retire,
    dialog: currentAttempt ? (
      <AgentSessionContinuationDialog
        key={currentAttempt.operation}
        open
        request={request}
        onOpenChange={(isOpen) => {
          if (!isOpen && active.current === currentAttempt) {
            retire()
          }
        }}
      />
    ) : null
  }
}
