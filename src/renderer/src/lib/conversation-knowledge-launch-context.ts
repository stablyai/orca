import {
  buildConversationKnowledgeContextPack,
  type ConversationKnowledgeItem
} from '../../../shared/conversation-knowledge-items'
import {
  LOCAL_EXECUTION_HOST_ID,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'

let launchContextItems: readonly ConversationKnowledgeItem[] = []

export function replaceConversationKnowledgeLaunchItems(
  items: readonly ConversationKnowledgeItem[]
): void {
  launchContextItems = [...items]
}

export function getConversationKnowledgeLaunchItems(): readonly ConversationKnowledgeItem[] {
  return launchContextItems
}

export function buildConversationKnowledgeLaunchPrompt(args: {
  prompt: string
  cwd: string
  executionHostId: ExecutionHostId
  items: readonly ConversationKnowledgeItem[]
}): string {
  const prompt = args.prompt.trim()
  if (!prompt) {
    return ''
  }
  const context = buildConversationKnowledgeContextPack({
    items: args.items.filter((item) => item.source.executionHostId === args.executionHostId),
    cwd: args.cwd
  })
  return context ? `${context}\n\nCurrent task:\n${prompt}` : prompt
}

export function buildConversationKnowledgeRemoteLaunchPrompt(args: {
  prompt: string
  worktree: { path: string; hostId?: ExecutionHostId } | undefined
  sshConnectionId: string | null | undefined
}): string {
  if (!args.worktree || args.sshConnectionId === undefined) {
    return args.prompt
  }
  return buildConversationKnowledgeLaunchPrompt({
    prompt: args.prompt,
    cwd: args.worktree.path,
    executionHostId:
      args.worktree.hostId ??
      (typeof args.sshConnectionId === 'string'
        ? toSshExecutionHostId(args.sshConnectionId)
        : LOCAL_EXECUTION_HOST_ID),
    items: getConversationKnowledgeLaunchItems()
  })
}
