import { useAgentStatus } from '@/runtime/agent-status/use-agent-status'

/** The pane's hook-reported reply preview and turn epochs, for the terminal-backed chat view. */
export function useNativeChatHookTurn(paneKey: string) {
  const status = useAgentStatus(paneKey)
  return {
    // Preview the in-progress hook reply before its completed transcript turn arrives.
    hookPreview: status?.lastAssistantMessage,
    // Tool stdout/errors ride the same field for status-card previews; they are not the reply.
    hookPreviewIsToolOutput: status?.lastAssistantMessageIsToolOutput === true,
    // A coalesced interrupt/restart can stay working; the newer epoch must still clear Stop suppression.
    workingEpoch: status?.stateStartedAt ?? null,
    turnEpoch: status?.turnStartedAt ?? null
  }
}
