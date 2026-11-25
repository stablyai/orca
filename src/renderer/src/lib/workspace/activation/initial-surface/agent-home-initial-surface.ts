// An agent's home opens on its chat, never on a seeded shell. The agents' code says which workspaces
// are homes and opens their chats; activation asks through here, so it imports none of that code.
type AgentHomeChatOpener = (worktreeId: string) => boolean

let opener: AgentHomeChatOpener = () => false

export function setAgentHomeChatOpener(open: AgentHomeChatOpener): () => void {
  opener = open
  return () => {
    opener = () => false
  }
}

/** True when `worktreeId` is an agent's home: its chat opens (or will) in place of a shell. */
export function openAgentHomeChatInsteadOfShell(worktreeId: string): boolean {
  return opener(worktreeId)
}
