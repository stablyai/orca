import { NativeChatForkContext, NativeChatForkSlotContext } from './native-chat-fork-context'
import { NativeChatForkWindowHost } from './fork-window/NativeChatForkWindow'
import { terminalForkTurnEnd } from '../../../../../../shared/native-chat/terminal-fork-point'
import { useNativeChatWorktreeForkRequest } from './native-chat-worktree-fork-requests'
import { useNativeChatTerminalFork } from './use-native-chat-terminal-fork'
import { useNativeChatTabOwnerWorktreeId } from '@/components/native-chat/pane/ownership/use-native-chat-tab-owner'
import { useWorktreeRuntimeTarget } from '@/runtime/rpc/targets/use-worktree-runtime-target'
import { NativeChatSubagentTranscripts } from '../../subagents/NativeChatSubagentTranscripts'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'

/** Gives a terminal chat's rows the same Fork as a chat session, through the CLI's own resume. */
export function NativeChatTerminalForkProvider({
  agent,
  sessionId,
  transcriptPath,
  terminalTabId,
  messages,
  children
}: {
  agent: string
  sessionId: string | null
  transcriptPath: string | null
  terminalTabId: string
  messages: readonly NativeChatMessage[]
  children: React.ReactNode
}): React.JSX.Element {
  const worktreeId = useNativeChatTabOwnerWorktreeId(terminalTabId)
  const target = useWorktreeRuntimeTarget(worktreeId)
  const fork = useNativeChatTerminalFork({
    agent,
    source:
      sessionId && transcriptPath && worktreeId ? { sessionId, transcriptPath, worktreeId } : null,
    messages
  })
  useNativeChatWorktreeForkRequest(terminalTabId, fork?.openWorktreeForkLatest)
  return (
    <NativeChatForkContext.Provider value={fork}>
      <NativeChatForkSlotContext.Provider value={fork !== undefined}>
        {children}
        {fork?.worktreeForkDialog && worktreeId && sessionId ? (
          <NativeChatForkWindowHost
            dialog={fork.worktreeForkDialog}
            source={{
              kind: 'terminal',
              agent: 'claude',
              sessionId,
              worktreeId,
              target: target ?? { kind: 'local' },
              label: agent,
              // A terminal chat shows no usage-limit stop, so the window keeps its agent.
              usageLimited: false,
              subagentOffered: false,
              newWorktreeOffered: fork.worktreeForkOffered === true,
              destinationOffered: fork.worktreeForkOffered === true,
              messages: () => messages,
              cutThrough: (throughItemId) =>
                terminalForkTurnEnd(messages, throughItemId) ?? throughItemId,
              request: fork.request
            }}
          />
        ) : null}
      </NativeChatForkSlotContext.Provider>
    </NativeChatForkContext.Provider>
  )
}

/** The transcript view, with the terminal Fork available to its rows. */
export function NativeChatForkableTranscripts({
  fork,
  ...transcripts
}: React.ComponentProps<typeof NativeChatSubagentTranscripts> & {
  fork: Omit<React.ComponentProps<typeof NativeChatTerminalForkProvider>, 'children'>
}): React.JSX.Element {
  return (
    <NativeChatTerminalForkProvider {...fork}>
      <NativeChatSubagentTranscripts {...transcripts} />
    </NativeChatTerminalForkProvider>
  )
}
