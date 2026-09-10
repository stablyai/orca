import { GitFork } from 'lucide-react'
import { activateStructuredAgentSessionById } from '@/lib/structured-agent-session-tab-activation'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'

type AppState = ReturnType<typeof useAppStore.getState>

/** A forked chat's own tab is the only place its parent is named, so the label comes from the
 *  parent's tab the same way every other surface reads a chat's title. */
function parentChatLabel(
  state: AppState,
  worktreeId: string | undefined,
  parentSessionId: string | undefined
): string | undefined {
  if (!worktreeId || !parentSessionId) {
    return undefined
  }
  const tab = (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
    (candidate) =>
      candidate.contentType === 'agent-session' && candidate.entityId === parentSessionId
  )
  const label = tab?.customLabel ?? tab?.generatedLabel ?? tab?.label
  return label && label.trim().length > 0 ? label : undefined
}

/** One line of lineage in the child's header — not a fork tree, and not a browser. It renders
 *  NOTHING when the parent cannot be named: a closed parent would otherwise leave a raw session id
 *  and a control that goes nowhere. */
export function NativeChatForkedFromLine({
  worktreeId,
  parentSessionId
}: {
  worktreeId: string | undefined
  parentSessionId: string | undefined
}): React.JSX.Element | null {
  const parentLabel = useAppStore((state) => parentChatLabel(state, worktreeId, parentSessionId))
  if (!worktreeId || !parentSessionId || !parentLabel) {
    return null
  }
  return (
    <div className="mx-auto flex w-full max-w-4xl shrink-0 items-center gap-1.5 px-4 pt-2 text-xs text-muted-foreground">
      <GitFork className="size-3.5 shrink-0" />
      <span className="shrink-0">
        {translate('components.native-chat.forkedFrom', 'Forked from')}
      </span>
      <button
        type="button"
        title={parentLabel}
        onClick={() => {
          activateStructuredAgentSessionById({ worktreeId, sessionId: parentSessionId })
        }}
        className="truncate rounded-sm font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {parentLabel}
      </button>
    </div>
  )
}
