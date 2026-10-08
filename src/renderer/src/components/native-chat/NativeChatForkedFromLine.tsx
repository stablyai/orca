import { GitFork } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import {
  activateStructuredAgentSessionById,
  findStructuredAgentSessionTab
} from '@/lib/structured-agent-session-tab-activation'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { useStructuredChatTabConversationName } from '@/runtime/structured-conversation-name'
import { useAppStore } from '@/store'
import { useStructuredAgentSessionForkedFrom } from './StructuredAgentSessionStatusBridge'

/**
 * The chat this one was forked from, as one line above its transcript. Draws nothing while the
 * parent has no tab to name it by or go to: a closed parent would leave a raw id and a dead link.
 */
export function NativeChatForkedFromLine({
  sessionId,
  target,
  worktreeId
}: {
  sessionId: string
  target: RuntimeClientTarget
  worktreeId: string | null | undefined
}): React.JSX.Element | null {
  const parentSessionId = useStructuredAgentSessionForkedFrom(sessionId, target)
  const parentTab = useAppStore((state) =>
    worktreeId && parentSessionId
      ? findStructuredAgentSessionTab(state.unifiedTabsByWorktree, {
          workspaceId: worktreeId,
          sessionId: parentSessionId
        })
      : null
  )
  const conversationName = useStructuredChatTabConversationName(parentTab ?? undefined)
  // The same title the tab strip gives the chat.
  const parentLabel = (parentTab?.customLabel ?? conversationName ?? parentTab?.label)?.trim()
  if (!worktreeId || !parentSessionId || !parentLabel) {
    return null
  }
  return (
    <div className="mx-auto flex w-full max-w-4xl shrink-0 items-center gap-1.5 px-4 pt-2 text-xs text-muted-foreground">
      <GitFork className="size-3.5 shrink-0" aria-hidden />
      <span className="shrink-0">
        {translate('components.native-chat.fork.forkedFrom', 'Forked from')}
      </span>
      <button
        type="button"
        title={parentLabel}
        onClick={() =>
          activateStructuredAgentSessionById({ worktreeId, sessionId: parentSessionId })
        }
        className="truncate rounded-sm font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {parentLabel}
      </button>
    </div>
  )
}
