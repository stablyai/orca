import { useState } from 'react'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { useStructuredAgentSessionStatusSummary } from './structured-agent-session-status-hooks'
import { activateAiVaultStructuredSession } from '@/lib/activate-ai-vault-structured-session'
import { translate } from '@/i18n/i18n'

export function NativeChatForkSource({
  sessionId,
  worktreeId,
  target
}: {
  sessionId: string
  worktreeId: string | null | undefined
  target: RuntimeClientTarget
}) {
  const { summary } = useStructuredAgentSessionStatusSummary(sessionId, target)
  const [opening, setOpening] = useState(false)
  const source = summary?.forkedFrom
  if (!source) {
    return null
  }
  return (
    <div className="px-4 py-1 text-xs text-chat-foreground-faint">
      <button
        type="button"
        disabled={!worktreeId || opening}
        className="rounded-md hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        onClick={async () => {
          if (!worktreeId || opening) {
            return
          }
          setOpening(true)
          try {
            await activateAiVaultStructuredSession(
              { structuredSession: { workspaceId: worktreeId, sessionId: source.sessionId } },
              undefined,
              target
            )
          } finally {
            setOpening(false)
          }
        }}
      >
        {translate('components.native-chat.fork.source', 'Forked from parent chat')}
      </button>
    </div>
  )
}
