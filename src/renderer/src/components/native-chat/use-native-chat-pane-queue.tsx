import type { RefObject } from 'react'
import { useAppStore } from '@/store'
import { getKnownExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { findTerminalTabWorktreeId } from './native-chat-file-link'
import { useNativeChatTerminalQueuedMessages } from './use-native-chat-terminal-queued-messages'
import { NativeChatQueuedMessageList } from './NativeChatQueuedMessageList'
import type { NativeChatLiveSession } from './native-chat-live-session-contract'
import type { NativeChatComposerHandle } from './native-chat-composer-types'

type QueueArgs = Parameters<typeof useNativeChatTerminalQueuedMessages>[0]
export function useNativeChatPaneQueue(
  session: NativeChatLiveSession,
  onPresenceChange: (present: boolean) => void,
  args: Pick<QueueArgs, 'ptyId' | 'agent' | 'canSend' | 'promptOpen' | 'onSend' | 'outcome'> & {
    terminalTabId: string
    paneKey: string
    sessionId: string | null
    runtimeEnvironmentId: string | null
    stop: {
      clear: () => void
      setWorkingInterrupted: (value: boolean) => void
      interactiveSend: { cancel: () => void }
    }
    worktreeId: string | null
    composerRef: RefObject<NativeChatComposerHandle | null>
  }
) {
  const hostId = useAppStore((state) =>
    getKnownExecutionHostIdForWorktree(
      state,
      findTerminalTabWorktreeId(state.tabsByWorktree, args.terminalTabId)
    )
  )
  const completed =
    session.transcriptLifecycle?.state === 'completed' ? session.transcriptLifecycle : null
  const queue = useNativeChatTerminalQueuedMessages({
    ...args,
    onPresenceChange,
    scope: JSON.stringify([
      hostId,
      args.runtimeEnvironmentId,
      args.terminalTabId,
      args.paneKey,
      args.agent,
      args.sessionId
    ]),
    working: session.status === 'working',
    completedAt: completed?.timestamp ?? null,
    completedTurn: completed?.turnId ?? null,
    ready: hostId !== null && args.sessionId !== null && session.readPhase === 'ready'
  })
  return {
    ...queue,
    enqueue: args.sessionId === null && session.status !== 'working' ? () => null : queue.enqueue,
    stop: () => {
      queue.pause()
      args.stop.setWorkingInterrupted(true)
      args.stop.clear()
      args.stop.interactiveSend.cancel()
    },
    list: (
      <NativeChatQueuedMessageList
        controller={queue.controller}
        chatWorktreeId={args.worktreeId}
        steerHeld={!args.canSend || args.promptOpen}
        focusComposer={() => args.composerRef.current?.focus()}
      />
    )
  }
}
