import { useEffect, useMemo } from 'react'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import { structuredAgentSessionDraftScopeKey } from '../drafts/native-chat-draft-scope'
import {
  anchorNativeChatShellRunsAfterTurn,
  isSendableNativeChatShellRun,
  registerNativeChatShellHost,
  runNativeChatShellCommand,
  useNativeChatShellRuns
} from './native-chat-shell-runs'
import { subscribeNativeChatShellCommand } from './native-chat-shell-subscription'

type NativeChatShellTransport = {
  runShellCommand: (command: string) => void
  hasAddedShellResults: boolean
}

export function useNativeChatShellHost(args: {
  target: RuntimeClientTarget
  sessionId: string
  isWorking: boolean
  lastMessageId: string | undefined
}): NativeChatShellTransport {
  const { target, sessionId, isWorking, lastMessageId } = args
  const scope = structuredAgentSessionDraftScopeKey(sessionId)
  useEffect(
    () =>
      registerNativeChatShellHost(scope, {
        run: (command, sink) => subscribeNativeChatShellCommand(target, sessionId, command, sink),
        anchor: () =>
          isWorking
            ? { id: null, awaitingTurn: true }
            : { id: lastMessageId ?? null, awaitingTurn: false }
      }),
    [isWorking, lastMessageId, scope, sessionId, target]
  )
  useEffect(() => {
    if (!isWorking && lastMessageId) {
      anchorNativeChatShellRunsAfterTurn(scope, lastMessageId)
    }
  }, [isWorking, lastMessageId, scope])
  const hasAddedShellResults =
    useNativeChatShellRuns((run) => isSendableNativeChatShellRun(run, scope)).length > 0
  return useMemo(
    () => ({
      runShellCommand: (command: string) => runNativeChatShellCommand(scope, command),
      hasAddedShellResults
    }),
    [hasAddedShellResults, scope]
  )
}
