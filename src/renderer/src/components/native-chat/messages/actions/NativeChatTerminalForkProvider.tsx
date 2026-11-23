import { NativeChatForkContext, NativeChatForkSlotContext } from './native-chat-fork-context'
import { NativeChatForkWindowHost } from './fork-window/NativeChatForkWindow'
import { terminalForkTurnEnd } from '../../../../../../shared/native-chat/terminal-fork-point'
import { useNativeChatWorktreeForkRequest } from './native-chat-worktree-fork-requests'
import { useNativeChatTerminalFork } from './use-native-chat-terminal-fork'
import { useNativeChatTabOwnerWorktreeId } from '@/components/native-chat/pane/ownership/use-native-chat-tab-owner'
import { useWorktreeRuntimeTarget } from '@/runtime/rpc/targets/use-worktree-runtime-target'
import { useStructuredAgentSessionHostCapabilityState } from '@/runtime/native-chat/host-capabilities/structured-agent-session-host-capability'
import { AI_VAULT_TERMINAL_FORK_CUT_CAPABILITY } from '../../../../../../shared/ai-vault/resume/ai-vault-resume-preparation'
import { NativeChatSubagentTranscripts } from '../../subagents/NativeChatSubagentTranscripts'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { isTuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent-config'

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
  const hostCut = useStructuredAgentSessionHostCapabilityState(
    target ?? { kind: 'local' },
    AI_VAULT_TERMINAL_FORK_CUT_CAPABILITY
  )
  // A direct-SSH workspace has no runtime target; this computer's cut support says nothing about it.
  const cutHost = worktreeId && !target ? 'unsupported' : hostCut
  const fork = useNativeChatTerminalFork({
    agent,
    worktreeId,
    source:
      sessionId && transcriptPath && worktreeId ? { sessionId, transcriptPath, worktreeId } : null,
    messages,
    cutHost
  })
  useNativeChatWorktreeForkRequest(terminalTabId, fork?.openWorktreeForkLatest)
  return (
    <NativeChatForkContext.Provider value={fork}>
      <NativeChatForkSlotContext.Provider value={fork !== undefined}>
        {children}
        {fork?.worktreeForkDialog && worktreeId && isTuiAgent(agent) ? (
          <NativeChatForkWindowHost
            dialog={fork.worktreeForkDialog}
            source={{
              kind: 'terminal',
              agent,
              // Only a Claude chat's history can be copied exactly.
              sessionId: agent === 'claude' && sessionId ? sessionId : '',
              cutsHere:
                agent === 'claude' &&
                Boolean(sessionId && transcriptPath) &&
                cutHost === 'supported',
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
